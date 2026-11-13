import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";

// YN-78 S2c: an executor's Overview (not Home) shows its own temporary
// directory's latest measurement against the 2 GiB soft line, in the built
// app against a fixture Core. Core's `agent.tempUsage` (its revision only)
// reaches the app by its real event stream: the Overview showing that
// executor reads again, and nothing else does (Home, the list, the board).
// Unknown says why, with the last count apart; an older Core's answer
// without one is "not measured yet", never 0; a reply after a newer read is
// never written over it. English and Chinese. Synthetic executors only.
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
/** Gives the app time to act on what it was just told, for a check that nothing happened. */
const settle = () => pause(400);

const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const GiB = 2 ** 30;
const project = { id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" };
const lifecycle = (id, tempDir) => ({
  state: "running", agentId: id, dispatcher: { kind: "agent", id: "lead", name: "Dev Lead 2" },
  task: { id: `YN-${id}`, title: `Work ${id}` }, template: { id: "build", label: "Build from design" }, dispatchedAt: at(30), since: at(5),
  ...(tempDir === undefined ? {} : { tempDir }),
});
const agent = (id, extra = {}) => ({
  id, name: `Agent ${id}`, goal: "", cwd: "/synthetic/work", model: "m", color: "sage", status: "idle", harness: "opencode",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", ...extra,
});
const executor = (id) => agent(id, { name: `YN-${id} · Build from design`, kind: "executor", executor: lifecycle(id) });
const measured = (bytes, revision = 1, extra = {}) =>
  ({ revision, state: "measured", bytes, at: at(2), limitBytes: 2 * GiB, over: bytes >= 2 * GiB, lastMeasured: { bytes, at: at(2) }, ...extra });
const overviewOf = (id, tempDir) => ({
  agentId: id, lifecycle: lifecycle(id, tempDir), task: { id: `YN-${id}`, title: `Work ${id}`, status: "doing" },
  template: { id: "build", label: "Build from design", deliveryMode: "pr" }, materials: null,
  steps: [{ kind: "work", state: "doing" }], jobs: [], pullRequest: null, merge: null, result: null,
});

async function mount({ tempDir = { "k": { path: "/synthetic/data/t/k", usage: measured(40 * 1024) } }, storage = {}, hold = null } = {}) {
  const errors = [];
  const calls = [];
  const streams = [];
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
  w.EventSource = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      streams.push(this);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  const respond = (value, status = 200) => {
    const text = JSON.stringify(value);
    return { ok: status === 200, status, json: async () => JSON.parse(text), text: async () => text };
  };
  const listed = [executor("k"), executor("w"), agent("s")];
  // What Core answers for each executor's Overview now; a test changes it.
  const core = { tempDir: { ...tempDir } };
  w.fetch = async (url, init = {}) => {
    const { pathname: path } = new URL(String(url), w.location.href);
    calls.push(path);
    if (path === "/api/workspace") return respond({ workspace: { id: "ws-temp-usage" }, projects: [project], agents: listed, runtime: { connected: true }, defaultCwd: "/w" });
    if (path === "/api/home") return respond({ generatedAt: at(0), order: ["p"], needsYou: [], projects: [] });
    if (path === "/api/executors/live") return respond({ executors: {} });
    if (path.endsWith("/task_list")) return respond({ tasks: [], counts: {}, hasMore: false });
    const read = path.match(/^\/api\/agents\/(\w)\/executor$/);
    if (read) {
      const answer = respond(overviewOf(read[1], core.tempDir[read[1]]));
      // A read the test holds, answered when it says.
      if (hold && hold(read[1], calls.filter((c) => c === path).length)) return new Promise((done) => core.release = () => done(answer));
      return answer;
    }
    const detail = path.match(/^\/api\/agents\/(\w)$/);
    if (detail) return respond({ agent: listed.find((a) => a.id === detail[1]), pending: [], artifacts: [], messageReceipts: [], turns: [] });
    if (path === "/api/machines") return respond({ machines: [] });
    return respond({});
  };
  const doc = w.document;
  w.eval(bundle);
  await waitFor(() => doc.querySelector('.agent-list article[data-agent-id="s"]'), "the sidebar lists the Agents");
  const stream = () => streams.at(-1);
  stream().readyState = 1;
  stream().onopen?.({});
  let n = 0;
  // As Core sends it: one message on the open stream.
  const send = (data) => stream().onmessage?.({ data: JSON.stringify(data), lastEventId: `e-${++n}` });
  // A new stream starts as Core starts one, and its reads are over before a test counts any.
  send({ type: "reset", reason: "new" });
  await settle();
  const panel = () => doc.querySelector("#executor-overview");
  return {
    w, doc, core, send, errors, panel,
    open: (id) => doc.querySelector(`.agent-list article[data-agent-id="${id}"] .agent-select`).click(),
    count: (path) => calls.filter((c) => c === path || (path === "board" && c.endsWith("/task_list"))).length,
    reads: (id) => calls.filter((c) => c === `/api/agents/${id}/executor`).length,
    line: () => panel()?.querySelector(".executor-overview-temp") ?? null,
    loaded: () => !!panel()?.querySelector(".executor-overview-head"),
    close: () => w.close(),
  };
}

test("its Overview reads again for its own agent.tempUsage only: never Home, the list or the board", async () => {
  const p = await mount();
  try {
    p.open("k");
    await waitFor(() => p.loaded() && p.line(), "k's Overview shows its temporary files");
    assert.equal(p.line().dataset.state, "ok");
    assert.equal(p.line().querySelector("strong").textContent, "Temporary files");
    assert.equal(p.line().querySelector(".v").textContent, "40 KiB of the 2 GiB soft line");
    assert.match(p.line().querySelector(".note").textContent, /^last measured /);
    assert.equal(p.line().querySelector(".over"), null);
    // Opening it moves other revisions too (its board, Jobs, Asks): what they read is over before counting.
    await settle();
    const first = p.reads("k");
    const before = { home: p.count("/api/home"), workspace: p.count("/api/workspace"), board: p.count("board"), w: p.reads("w") };

    // Its own measurement, now over the line.
    p.core.tempDir.k = { path: "/synthetic/data/t/k", usage: measured(3 * GiB, 2) };
    p.send({ type: "agent.tempUsage", agentId: "k", revision: 2 });
    await waitFor(() => p.line()?.dataset.state === "over", "read again, it says the soft line is reached");
    assert.equal(p.reads("k"), first + 1, "one more read of its Overview");
    assert.equal(p.line().querySelector(".v").textContent, "3 GiB of the 2 GiB soft line");
    assert.equal(p.line().querySelector(".over").textContent, "At the soft line: a notice only. Nothing is cleaned up, paused or refused.");

    // Another executor's: nothing is read.
    p.send({ type: "agent.tempUsage", agentId: "w", revision: 7 });
    // One that doesn't parse: nothing at all, not a reset.
    p.send({ type: "agent.tempUsage", agentId: "k", revision: "x" });
    await settle();
    assert.equal(p.reads("k"), first + 1);
    assert.deepEqual({ home: p.count("/api/home"), workspace: p.count("/api/workspace"), board: p.count("board"), w: p.reads("w") }, before,
      "Home, the list, the board and the other executor are not read");

    // Its Conversation shown instead: no Overview, no read.
    [...p.doc.querySelectorAll('.executor-tabs [role="tab"]')].find((b) => b.textContent === "Conversation").click();
    await waitFor(() => !p.panel(), "its Conversation");
    p.send({ type: "agent.tempUsage", agentId: "k", revision: 3 });
    await settle();
    assert.equal(p.reads("k"), first + 1, "no Overview shown, nothing read");
    // Home open: nothing read either, and Home's own reads don't grow for it.
    p.doc.querySelector(".catchup-nav").click();
    await waitFor(() => p.doc.querySelector(".catchup-nav.selected"), "Home");
    await settle();
    const home = p.count("/api/home");
    p.send({ type: "agent.tempUsage", agentId: "k", revision: 4 });
    await settle();
    assert.equal(p.reads("k"), first + 1);
    assert.equal(p.count("/api/home"), home, "Home is not read again for it");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("unknown says why with the last count apart; none read, or an older Core, is not measured yet, never 0", async () => {
  const p = await mount({ tempDir: {
    k: { path: "/synthetic/data/t/k", usage: { revision: 3, state: "unknown", bytes: null, reason: "busy", at: at(1), limitBytes: 2 * GiB,
      lastMeasured: { bytes: 12 * 1024 * 1024 + 300 * 1024, at: at(20) } } },
    // An older Core: a directory, no usage.
    w: { path: "/synthetic/data/t/w" },
  } });
  try {
    p.open("k");
    await waitFor(() => p.line(), "k's line");
    assert.equal(p.line().dataset.state, "unknown");
    assert.equal(p.line().querySelector(".v").textContent, "unknown: another measurement was still running");
    const notes = [...p.line().querySelectorAll(".note")].map((n) => n.textContent);
    assert.equal(notes.length, 2);
    assert.match(notes[0], /^last measured /);
    assert.match(notes[1], /^last count 12\.3 MiB, /);
    // A reason this web doesn't know: still unknown, never a number.
    p.core.tempDir.k = { path: "/synthetic/data/t/k", usage: { revision: 4, state: "unknown", bytes: null, reason: "something-new", at: at(0), limitBytes: 2 * GiB } };
    p.send({ type: "agent.tempUsage", agentId: "k", revision: 4 });
    await waitFor(() => p.line()?.querySelector(".v").textContent === "unknown: Core couldn't count it", "an unknown reason");
    assert.equal(p.line().querySelectorAll(".note").length, 1, "no last count to show");

    p.open("w");
    await waitFor(() => p.loaded() && p.panel().querySelector(".executor-overview-head h2")?.textContent.startsWith("YN-w"), "w's Overview");
    assert.equal(p.line().dataset.state, "none");
    assert.equal(p.line().querySelector(".v").textContent, "not measured yet");
    assert.equal(p.line().querySelectorAll(".note").length, 0);
    assert.doesNotMatch(p.line().textContent, /\b0\b/, "never 0");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
  // No temporary directory at all: no line.
  const none = await mount({ tempDir: { k: undefined } });
  try {
    none.open("k");
    await waitFor(() => none.loaded(), "k's Overview");
    assert.equal(none.line(), null);
  } finally {
    none.close();
  }
});

test("in Chinese", async () => {
  const p = await mount({ storage: { "yuzuno.language": JSON.stringify({ language: "zh-Hans" }) },
    tempDir: { k: { path: "/synthetic/data/t/k", usage: measured(2 * GiB) }, w: { path: "/synthetic/data/t/w",
      usage: { revision: 2, state: "unknown", bytes: null, reason: "timeout", at: at(1), limitBytes: 2 * GiB, lastMeasured: { bytes: 2048, at: at(9) } } } } });
  try {
    p.open("k");
    await waitFor(() => p.line(), "k's line");
    assert.equal(p.line().querySelector("strong").textContent, "临时文件占用");
    assert.equal(p.line().querySelector(".v").textContent, "2 GiB / 2 GiB 软提示线");
    assert.match(p.line().querySelector(".note").textContent, /^上次测量 /);
    assert.equal(p.line().querySelector(".over").textContent, "已到软提示线：只是提示，不会清理、暂停或拒绝任何工作。");
    p.open("w");
    await waitFor(() => p.line()?.dataset.state === "unknown", "w's line");
    assert.equal(p.line().querySelector(".v").textContent, "未知：超过 2 秒");
    assert.match([...p.line().querySelectorAll(".note")][1].textContent, /^上次成功 2 KiB（/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a reply that arrives after a newer read is never written over it", async () => {
  // The first read of k's Overview is held; the next is answered at once.
  const p = await mount({ hold: (id, nth) => id === "k" && nth === 1 });
  try {
    p.open("k");
    // Later reads, as opening it moves other revisions, are answered at once.
    await waitFor(() => p.reads("k") >= 1 && p.core.release, "the first read is on its way");
    p.core.tempDir.k = { path: "/synthetic/data/t/k", usage: measured(64 * 1024, 2) };
    p.send({ type: "agent.tempUsage", agentId: "k", revision: 2 });
    await waitFor(() => p.line()?.querySelector(".v").textContent === "64 KiB of the 2 GiB soft line", "the newer read is shown");
    // Now the first, older answer (40 KiB, as Core said then) arrives: it is not shown.
    p.core.release();
    await settle();
    assert.equal(p.line().querySelector(".v").textContent, "64 KiB of the 2 GiB soft line");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
