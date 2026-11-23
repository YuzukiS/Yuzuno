// YN-221 S4: the page reads the Agent list slim (released executors as slim
// rows, asked for with `X-Yuzuno-Listing: slim`) and a released executor's full row once, when it is
// opened; an older Core, which sends every row whole, is read as before.
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
const bundle = await uiTestBundle(new URL(index.match(/src="\/(assets\/[^" ]+\.js)"/)[1], dist));
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function until(check, label) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await pause(20);
  }
  assert.ok(check(), `${label} should settle`);
}

const base = { cwd: "/w", model: "m", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, reviewedSeq: 0, harness: "codex" };
const working = { ...base, id: "a", name: "Mori", goal: "Keep it green", status: "working", lastSeq: 10, rev: 10, settings: {}, lastMessage: "On it" };
const releasedFull = { ...base, id: "r", name: "Released one", goal: "Ship the slice", kind: "executor", status: "idle", closedAt: "then",
  lastSeq: 5, rev: 5, settings: {}, lastMessage: "Done", releasedAt: "then", executor: { state: "archived", since: "then" } };
// Another Workspace's Agent with the same id (a Core restored from a backup), and fields of its own.
const releasedOther = { ...releasedFull, name: "Released two", goal: "Another workspace's goal", lastMessage: "Other" };
const releasedSlim = { id: "r", name: "Released one", kind: "executor", harness: "codex", status: "idle", color: "sage", createdAt: "", updatedAt: "",
  closedAt: "then", releasedAt: "then", rev: 5, lastSeq: 5, reviewedSeq: 0, pendingCount: 0, unreadCount: 0, cwd: "/w",
  executor: { state: "archived", since: "then" }, listing: "slim" };

/**
 * slim: Core sends released executors slim. listing(ctx): Core's answer to `/api/agents/r/listing` (a body, or a
 * promise of one; a rejected one is a 500), ctx = { workspace, n }; by default the open Workspace's full row.
 * The open Workspace is `state.workspace` ("w" unless a test switches it); "w2" has its own Agent "r".
 */
async function mount({ slim, listing = null }) {
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
  // The released executor was the one open last time, in each Workspace.
  w.localStorage.setItem("yuzuno.selected.w", JSON.stringify("r"));
  w.localStorage.setItem("yuzuno.selected.w2", JSON.stringify("r"));
  const state = { workspace: "w", listings: 0 };
  const streams = [];
  w.EventSource = class {
    constructor() { this.readyState = 0; streams.push(this); }
    close() { this.readyState = 2; }
  };
  const calls = [];
  w.fetch = async (url, init = {}) => {
    const { pathname: path, search } = new URL(String(url), w.location.href);
    const headers = new w.Headers(init.headers || {});
    calls.push({ path, search, method: init.method || "GET", listing: headers.get("x-yuzuno-listing"), workspace: state.workspace });
    const other = state.workspace === "w2";
    const full = other ? releasedOther : releasedFull;
    let body = {};
    if (path === "/api/workspace" && headers.get("x-yuzuno-listing") === "slim" || path === "/api/workspace" && !slim) {
      body = { agents: [{ ...working }, slim ? { ...releasedSlim, name: full.name } : { ...full }], runtime: { connected: true }, defaultCwd: "/w",
        workspace: { id: state.workspace }, ...(slim ? { listing: "slim" } : {}) };
    } else if (path === "/api/agents/r/listing") {
      const ctx = { workspace: state.workspace, n: ++state.listings };
      try {
        body = listing ? await listing(ctx) : { ...full };
      } catch {
        return { ok: false, status: 500, json: async () => ({ error: "busy" }), text: async () => JSON.stringify({ error: "busy" }) };
      }
    } else if (path === "/api/agents/a" || path === "/api/agents/r") {
      const agent = path.endsWith("/a") ? working : full;
      body = { agent: { ...agent }, pending: [], artifacts: [], turns: [{ id: `t-${agent.id}`, status: "completed", items: [
        { id: `m-${agent.id}`, type: "agentMessage", text: `${agent.name} says hello` },
      ] }] };
    } else if (path === "/api/catchup") body = { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } };
    return { ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body) };
  };
  w.eval(bundle);
  const d = w.document;
  const heading = () => d.querySelector(".conversation-heading h1")?.textContent ?? "";
  const count = (path) => calls.filter((c) => c.path === path).length;
  const send = (data) => streams.at(-1)?.onmessage?.({ data: JSON.stringify(data), lastEventId: "" });
  const button = (text) => [...d.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  return { w, d, calls, count, errors, heading, send, streams, state, button, close: () => w.close() };
}

test("the list is read slim and a released executor opened is read whole once, its full row kept through later reads (YN-221 S4)", async () => {
  const p = await mount({ slim: true });
  try {
    await until(() => p.heading().includes("Released one"), "the released executor's conversation");
    const lists = p.calls.filter((c) => c.path === "/api/workspace");
    assert.ok(lists.length >= 1 && lists.every((c) => c.search === "" && c.listing === "slim"), `the list is asked for slim, at its own address: ${JSON.stringify(lists)}`);
    assert.equal(p.count("/api/agents/r/listing"), 1, "its full row, once");
    await until(() => p.d.querySelector('[data-item-id="m-r"]'), "its conversation");
    // Later reads of the slim list keep the full row it read.
    const stream = p.streams.at(-1);
    stream.readyState = 1;
    stream.onopen?.({});
    p.send({ type: "reset", refresh: true, reason: "new" });
    await until(() => p.count("/api/workspace") > lists.length, "the list read again");
    await pause(400);
    assert.match(p.heading(), /Released one/, "still open, whole");
    assert.equal(p.count("/api/agents/r/listing"), 1, "not read again");
    assert.ok(!p.d.body.textContent.includes("Opening this Agent"), "nothing waits for it");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("an older Core's whole rows are read as before, with no single row read (YN-221 S4)", async () => {
  const p = await mount({ slim: false });
  try {
    await until(() => p.heading().includes("Released one"), "the released executor's conversation");
    await pause(300);
    assert.equal(p.count("/api/agents/r/listing"), 0, "no full row is read");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a full row that can't be read says so where it was opened, and Retry reads only that row again (YN-221 S4)", async () => {
  const p = await mount({ slim: true, listing: ({ n }) => (n === 1 ? Promise.reject(new Error("busy")) : { ...releasedFull }) });
  try {
    await until(() => p.d.querySelector('[role="alert"]')?.textContent.includes("This Agent could not be opened."), "the failure, where it was opened");
    assert.ok(!p.d.body.textContent.includes("Opening this Agent"), "not still opening");
    const lists = p.count("/api/workspace");
    p.button("Retry").click();
    await until(() => p.heading().includes("Released one"), "opened on Retry");
    assert.equal(p.count("/api/agents/r/listing"), 2, "its row read again");
    assert.equal(p.count("/api/workspace"), lists, "nothing else read again for it");
    await until(() => p.d.querySelector('[data-item-id="m-r"]'), "its conversation");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("another Workspace's rows with the same id are never used, and a late answer for the one left changes nothing (YN-221 S4)", async () => {
  // Workspace w's read of its row is held; meanwhile Core answers as another Workspace (a restored backup).
  let release = null;
  const p = await mount({ slim: true, listing: ({ workspace }) => (workspace === "w" ? new Promise((_, reject) => { release = reject; }) : { ...releasedOther }) });
  try {
    await until(() => release, "w's row is being read");
    p.state.workspace = "w2";
    const stream = p.streams.at(-1);
    stream.readyState = 1;
    stream.onopen?.({});
    p.send({ type: "reset", refresh: true, reason: "new" });
    await until(() => p.heading().includes("Released two"), "w2's Agent, opened from its own row");
    // w's read fails only now: nothing changes for w2's Agent.
    release(new Error("late"));
    await pause(300);
    assert.match(p.heading(), /Released two/);
    assert.equal(p.d.querySelector('[role="alert"]'), null, "no failure is said for the Agent open now");
    assert.deepEqual(p.calls.filter((c) => c.path === "/api/agents/r/listing").map((c) => c.workspace), ["w", "w2"], "w2 read its own row");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
  // w's row read whole, then w2 lists the same id slim: w2 reads its own row, never w's fields.
  const q = await mount({ slim: true });
  try {
    await until(() => q.heading().includes("Released one"), "w's Agent");
    q.state.workspace = "w2";
    const stream = q.streams.at(-1);
    stream.readyState = 1;
    stream.onopen?.({});
    q.send({ type: "reset", refresh: true, reason: "new" });
    await until(() => q.heading().includes("Released two"), "w2's Agent");
    assert.deepEqual(q.calls.filter((c) => c.path === "/api/agents/r/listing").map((c) => c.workspace), ["w", "w2"]);
    assert.ok(!q.d.body.textContent.includes("Ship the slice"), "nothing of w's row");
    assert.deepEqual(q.errors, []);
  } finally {
    q.close();
  }
});
