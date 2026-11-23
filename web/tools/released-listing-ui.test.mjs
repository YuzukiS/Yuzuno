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
const releasedSlim = { id: "r", name: "Released one", kind: "executor", harness: "codex", status: "idle", color: "sage", createdAt: "", updatedAt: "",
  closedAt: "then", releasedAt: "then", rev: 5, lastSeq: 5, reviewedSeq: 0, pendingCount: 0, unreadCount: 0, cwd: "/w",
  executor: { state: "archived", since: "then" }, listing: "slim" };

async function mount({ slim }) {
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
  // The released executor was the one open last time.
  w.localStorage.setItem("yuzuno.selected.w", JSON.stringify("r"));
  const streams = [];
  w.EventSource = class {
    constructor() { this.readyState = 0; streams.push(this); }
    close() { this.readyState = 2; }
  };
  const calls = [];
  w.fetch = async (url, init = {}) => {
    const { pathname: path, search } = new URL(String(url), w.location.href);
    const headers = new w.Headers(init.headers || {});
    calls.push({ path, search, method: init.method || "GET", listing: headers.get("x-yuzuno-listing") });
    let body = {};
    if (path === "/api/workspace" && headers.get("x-yuzuno-listing") === "slim" || path === "/api/workspace" && !slim) {
      body = { agents: [{ ...working }, slim ? { ...releasedSlim } : { ...releasedFull }], runtime: { connected: true }, defaultCwd: "/w",
        workspace: { id: "w" }, ...(slim ? { listing: "slim" } : {}) };
    } else if (path === "/api/agents/r/listing") body = { ...releasedFull };
    else if (path === "/api/agents/a" || path === "/api/agents/r") {
      const agent = path.endsWith("/a") ? working : releasedFull;
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
  return { w, d, calls, count, errors, heading, send, streams, close: () => w.close() };
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
