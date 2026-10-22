// perf-sse: the GUI follows Core's event stream. Streamed changes patch the
// shown conversation in place; another Agent's events never read the shown
// Agent's detail again; only a change notice or a reset does.
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
// useWorkspaceEvents.ts; the seam below maps exactly these values.
const STALLED_MS = 10_000;
const REOPEN_MS = 3_000;
async function until(check, label = "condition") {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await pause(20);
  }
  assert.ok(check(), `${label} should settle`);
}

// A narrow seam for one product timer, installed before the bundle runs (React's
// scheduler keeps the setTimeout it finds then). Nothing is mapped unless a
// test calls during(): only while that synchronous call runs, a setTimeout whose
// delay is exactly one of the named product constants gets the scaled delay.
// Every other delay, setInterval and Date stay real.
function timerSeam(w) {
  const real = w.setTimeout;
  let mapping = null;
  const requested = [];
  const fired = [];
  w.setTimeout = function (handler, delay, ...args) {
    const scaled = mapping?.get(delay);
    if (scaled === undefined || typeof handler !== "function") return real.call(w, handler, delay, ...args);
    requested.push(delay);
    return real.call(w, (...a) => {
      fired.push(delay);
      return handler(...a);
    }, scaled, ...args);
  };
  return {
    requested,
    fired,
    during(map, fn) {
      mapping = new Map(Object.entries(map).map(([from, to]) => [Number(from), to]));
      try {
        return fn();
      } finally {
        mapping = null;
      }
    },
  };
}

async function mount() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4452/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.scrollTo = function () {};
  const timers = timerSeam(w);
  const base = { cwd: "/w", model: "m", color: "sage", status: "working", createdAt: "", updatedAt: "",
    unreadCount: 0, pendingCount: 0, reviewedSeq: 0 };
  const core = {
    agents: [
      { ...base, id: "a", name: "Mori", lastSeq: 10, rev: 10 },
      { ...base, id: "b", name: "Hana", lastSeq: 20, rev: 20 },
    ],
    text: "Streaming",
    calls: [],
    streams: [],
  };
  w.EventSource = class {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      core.streams.push(this);
    }
    close() { this.readyState = 2; }
  };
  w.fetch = async (url, init = {}) => {
    const path = new URL(String(url), w.location.href).pathname;
    core.calls.push({ path, method: init.method || "GET" });
    let body = {};
    if (path === "/api/workspace") body = { agents: core.agents.map((a) => ({ ...a })), runtime: { connected: true }, defaultCwd: "/w" };
    else if (/^\/api\/agents\/[ab]$/.test(path)) {
      const agent = core.agents.find((a) => path.endsWith(`/${a.id}`));
      body = { agent: { ...agent }, pending: [], artifacts: [], turns: [{ id: `t-${agent.id}`, status: "inProgress", items: [
        { id: `u-${agent.id}`, type: "userMessage", content: [{ type: "text", text: "Please go on." }] },
        { id: `m-${agent.id}`, type: "agentMessage", text: `${agent.name}: ${core.text}` },
      ] }] };
    } else if (path === "/api/catchup") body = { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } };
    return { ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body) };
  };
  w.eval(bundle);
  const d = w.document;
  try {
    await until(() => d.querySelector('[data-item-id="m-a"]'), "first conversation");
  } catch (error) {
    // A window left open keeps its poll running and the file alive.
    w.close();
    throw error;
  }
  const stream = () => core.streams.at(-1);
  const send = (data, id) => stream().onmessage?.({ data: JSON.stringify(data), lastEventId: id || "" });
  const count = (path) => core.calls.filter((c) => c.path === path).length;
  return { w, d, core, stream, send, count, errors, timers, close: () => w.close() };
}

test("streamed changes patch the shown Agent; another Agent's events never read it again", async () => {
  const p = await mount();
  try {
    // The stream opens and Core says to refetch (a fresh connection).
    p.stream().readyState = 1;
    p.stream().onopen?.({});
    const readsBefore = p.count("/api/agents/a");
    const listsBefore = p.count("/api/workspace");
    p.send({ type: "reset", refresh: true, reason: "new" }, "e-5");
    await until(() => p.count("/api/agents/a") > readsBefore && p.count("/api/workspace") > listsBefore,
      "the reset's detail and list reads");
    const reads = p.count("/api/agents/a");
    const lists = p.count("/api/workspace");
    assert.ok(reads >= 2, "the reset read the shown detail again");

    // Streamed text for the shown Agent: in place, no read.
    p.send({ type: "agent.delta", agentId: "a", rev: 11, turnId: "t-a", itemId: "m-a", op: "append", field: "text", text: " along" }, "e-6");
    p.send({ type: "agent.delta", agentId: "a", rev: 12, turnId: "t-a", itemId: "m-a", op: "append", field: "text", text: " nicely." }, "e-7");
    await until(() => p.d.querySelector('[data-item-id="m-a"]').textContent.includes("Streaming along nicely."), "patched text");
    p.send({ type: "agent.item", agentId: "a", rev: 13, turnId: "t-a", item: { id: "m2-a", type: "agentMessage", text: "A second message." } }, "e-8");
    await until(() => p.d.querySelector('[data-item-id="m2-a"]')?.textContent.includes("A second message."), "inserted Item");

    // Agent B streams and changes: its rail entry updates, A is never read.
    p.send({ type: "agent.delta", agentId: "b", rev: 21, turnId: "t-b", itemId: "m-b", op: "append", field: "text", text: " more" }, "e-9");
    p.send({ type: "agent.progress", agentId: "b", lastSeq: 22, agent: { ...p.core.agents[1], lastSeq: 22, rev: 22, status: "waiting", pendingCount: 1 } }, "e-10");
    p.send({ type: "agent.changed", agentId: "b", lastSeq: 23 }, "e-11");
    // Real time: longer than the 150 ms refetch, 100 ms flush and 250 ms list
    // read these events can start, and a refetch the list's answer could start.
    await pause(700);
    await until(() => p.count("/api/workspace") > lists, "B's change reads the Agent list");
    assert.equal(p.count("/api/agents/a"), reads, "nothing about B reads A's detail");
    assert.equal(p.count("/api/agents/b"), 0, "nor B's, which is not shown");
    assert.ok(p.count("/api/workspace") > lists, "B's change reads the Agent list");
    assert.match(p.d.querySelector('[data-item-id="m-a"]').textContent, /Streaming along nicely\./);

    // A change notice for the shown Agent reads it once, debounced.
    p.core.text = "Read again";
    p.core.agents[0].lastSeq = 30;
    p.core.agents[0].rev = 30;
    for (let n = 0; n < 5; n++) p.send({ type: "agent.changed", agentId: "a", lastSeq: 30 }, `e-${12 + n}`);
    await until(() => p.d.querySelector('[data-item-id="m-a"]').textContent.includes("Read again"), "refetched detail");
    // Real time: a second read would follow the 150 ms refetch cadence.
    await pause(300);
    assert.equal(p.count("/api/agents/a"), reads + 1, "five notices, one read");

    // A change for an Item this copy does not have: read again.
    p.send({ type: "agent.delta", agentId: "a", rev: 31, turnId: "t-a", itemId: "unknown", op: "append", field: "text", text: "x" }, "e-17");
    await until(() => p.count("/api/agents/a") === reads + 2, "refetch for an unknown Item");
    // Already in that read: nothing is applied twice.
    p.send({ type: "agent.delta", agentId: "a", rev: 29, turnId: "t-a", itemId: "m-a", op: "append", field: "text", text: " DUPLICATE" }, "e-18");
    // Real time: longer than the 100 ms flush that would apply it.
    await pause(250);
    assert.doesNotMatch(p.d.body.textContent, /DUPLICATE/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("an open stream does not poll; a closed one polls and a reopened one refetches", async () => {
  const p = await mount();
  try {
    const opened = p.core.calls.length;
    p.stream().readyState = 1;
    p.stream().onopen?.({});
    p.send({ type: "resumed", from: "e-1" });
    // The quiet baseline comes after the last read the opening starts: the
    // status bar's, 400 ms after the change (StatusBar.tsx).
    await until(() => p.core.calls.slice(opened).some((c) => c.path === "/api/reviews"), "the status bar's read after the stream opened");
    const quiet = p.core.calls.length;
    p.w.dispatchEvent(new p.w.Event("focus"));
    // Real time: a focus refetch is immediate; this covers its reads.
    await pause(200);
    assert.equal(p.core.calls.length, quiet, "focus does not refetch while live updates flow");
    // The stream drops: focus (and the 5 s poll) read again.
    p.stream().readyState = 0;
    p.stream().onerror?.({});
    await until(() => p.d.querySelector(".event-connection-banner"), "reconnecting banner");
    p.w.dispatchEvent(new p.w.Event("focus"));
    await until(() => p.core.calls.length > quiet, "focus refetches while disconnected");
    // The browser reconnects; Core cannot resume and says reset.
    const before = p.count("/api/agents/a");
    p.stream().readyState = 1;
    p.stream().onopen?.({});
    p.send({ type: "reset", refresh: true, reason: "expired" }, "e-40");
    await until(() => p.count("/api/agents/a") > before, "reset refetches");
    assert.ok(p.d.querySelector(".event-connection-banner") === null, ".event-connection-banner is absent");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a page that becomes visible, is restored or comes back online acts as focus does; hidden does nothing (T-170)", async () => {
  // A phone's browser brings a page back with these, often without a focus
  // event. Other parts of the app read on their own when the page becomes
  // visible (Jobs, CI, the job budget); what is counted here is what the event
  // stream starts: a workspace refetch and the shown Agent's read.
  const p = await mount();
  const snapshots = () => p.count("/api/workspace") + p.count("/api/agents/a");
  const triggers = {
    visibilitychange: () => p.d.dispatchEvent(new p.w.Event("visibilitychange")),
    pageshow: () => p.w.dispatchEvent(new p.w.Event("pageshow")),
    online: () => p.w.dispatchEvent(new p.w.Event("online")),
  };
  try {
    const opened = p.core.calls.length;
    p.stream().readyState = 1;
    p.stream().onopen?.({});
    p.send({ type: "resumed", from: "e-1" });
    await until(() => p.core.calls.slice(opened).some((c) => c.path === "/api/reviews"), "the status bar's read after the stream opened");
    const quiet = snapshots();
    const streams = p.core.streams.length;
    for (const fire of Object.values(triggers)) fire();
    // Real time: a refetch they started would be immediate; this covers its reads.
    await pause(200);
    assert.equal(snapshots(), quiet, "nothing is refetched while live updates flow");
    assert.equal(p.core.streams.length, streams, "and the open stream is kept");
    // The stream drops: each of them reads again at once.
    p.stream().readyState = 0;
    p.stream().onerror?.({});
    await until(() => p.d.querySelector(".event-connection-banner"), "reconnecting banner");
    for (const [name, fire] of Object.entries(triggers)) {
      const before = snapshots();
      fire();
      await until(() => snapshots() > before, `${name} refetches while disconnected`);
      await pause(200);
    }
    // A page that becomes hidden refetches nothing.
    Object.defineProperty(p.d, "visibilityState", { value: "hidden", configurable: true });
    const hidden = snapshots();
    triggers.visibilitychange();
    await pause(200);
    assert.equal(snapshots(), hidden, "becoming hidden refetches nothing");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a reconnect that never opens is replaced by a new connection resuming from the last id", async () => {
  const p = await mount();
  try {
    const first = p.stream();
    first.readyState = 1;
    first.onopen?.({});
    p.send({ type: "resumed", from: "e-1" });
    p.send({ type: "agent.changed", agentId: "b", lastSeq: 20 }, "e-42");
    // The connection drops and the browser's own retry hangs (CONNECTING).
    // The timer the drop starts runs ten times faster: STALLED_MS 10 s -> 1 s,
    // REOPEN_MS 3 s -> 300 ms (useWorkspaceEvents.ts).
    first.readyState = 0;
    p.timers.during({ [STALLED_MS]: STALLED_MS / 10, [REOPEN_MS]: REOPEN_MS / 10 }, () => first.onerror?.({}));
    assert.deepEqual(p.timers.requested, [STALLED_MS], "a hung retry waits STALLED_MS, not REOPEN_MS");
    // Twice the scaled REOPEN_MS, well short of the scaled STALLED_MS.
    await pause(2 * REOPEN_MS / 10);
    assert.equal(p.core.streams.length, 1, "the browser's own retry gets its chance first");
    await until(() => p.core.streams.length === 2, "replacement connection");
    assert.deepEqual(p.timers.fired, [STALLED_MS], "the scaled STALLED_MS timer replaced it");
    assert.equal(p.core.streams.length, 2, "replacement connection");
    assert.equal(first.readyState, 2, "the hung one is closed");
    assert.equal(p.stream().url, "/api/events?lastEventId=e-42");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("an offline report reads now and keeps the stream; online after it reconnects once from the last id, a plain online does not; nothing is written (T-170)", async () => {
  const p = await mount();
  const snapshots = () => p.count("/api/workspace") + p.count("/api/agents/a");
  const fire = (name) => p.w.dispatchEvent(new p.w.Event(name));
  try {
    const opened = p.core.calls.length;
    p.stream().readyState = 1;
    p.stream().onopen?.({});
    p.send({ type: "resumed", from: "e-1" }, "e-7");
    await until(() => p.core.calls.slice(opened).some((c) => c.path === "/api/reviews"), "the status bar's read after the stream opened");
    const streams = p.core.streams.length;
    const first = p.stream();

    // The browser says it is offline: the snapshot is read now; the open
    // stream is neither closed nor replaced.
    const before = snapshots();
    fire("offline");
    await until(() => snapshots() > before, "the offline report reads at once");
    assert.equal(p.core.streams.length, streams, "no new stream on an offline report");
    assert.equal(first.readyState, 1, "the open stream is kept");

    // Back online after it: one new stream, from the last id seen; the old one is closed.
    fire("online");
    await until(() => p.core.streams.length === streams + 1, "one reconnect on online");
    assert.equal(first.readyState, 2, "the old stream is closed");
    assert.match(p.stream().url, /lastEventId=e-7/, "it resumes from the last id");
    p.stream().readyState = 1;
    p.stream().onopen?.({});
    p.send({ type: "resumed", from: "e-7" });
    await pause(200);

    // Online without an offline report before it: as focus, no reconnect.
    fire("online");
    await pause(200);
    assert.equal(p.core.streams.length, streams + 1, "a plain online keeps the stream");

    // Several offline reports, then online: still one reconnect.
    fire("offline");
    fire("offline");
    fire("online");
    await until(() => p.core.streams.length === streams + 2, "one reconnect after repeated reports");
    fire("online");
    await pause(200);
    assert.equal(p.core.streams.length, streams + 2, "and only one");

    assert.deepEqual(p.core.calls.filter((c) => c.method !== "GET"), [], "nothing is written or sent again");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
