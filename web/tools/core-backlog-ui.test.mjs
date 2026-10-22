import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";
import { installConnectionFixture } from "./connection-fixture.mjs";

const dist = pathToFileURL(resolve(process.env.YUZUNO_UI_DIST || "dist") + "/");
const index = await readFile(new URL("index.html", dist), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)[1];
const bundle = await uiTestBundle(new URL(entry, dist));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what = "condition") {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await pause(15);
  }
  assert.ok(check(), `${what} should settle`);
}

const agentA = (oldestMs, pending = 42) => ({
  generation: 3,
  pending,
  oldestMs,
});
const backlog = (agents) => ({ observedAt: "2026-10-15T20:00:05Z", agents });

/** The real app on the connection fixture; /api/backlog answers `next`. */
async function mount(first = backlog({ a: agentA(0, 0), b: agentA(0, 0) })) {
  const errors = [],
    vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "http://127.0.0.1:4391/",
      runScripts: "outside-only",
      pretendToBeVisual: true,
      virtualConsole: vc,
    },
  );
  const w = dom.window;
  w.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.scrollTo = function () {};
  w.eval(`(${installConnectionFixture.toString()})({})`);
  const fixtureFetch = w.fetch;
  // `held`: answers wait until `release()`, to keep a read in flight.
  const state = { next: first, reads: 0, held: false, waiting: [] };
  state.release = () => state.waiting.splice(0).forEach((answer) => answer());
  w.fetch = async (url, init = {}) => {
    const path = new URL(String(url), w.location.href).pathname;
    if (path !== "/api/backlog") return fixtureFetch(url, init);
    state.reads++;
    const next = state.next;
    if (state.held) await new Promise((answer) => state.waiting.push(answer));
    const kind = (type) => ({
      get: (name) => (name.toLowerCase() === "content-type" ? type : null),
    });
    if (next === "offline")
      throw new TypeError("Simulated network disconnected");
    if (next === 404)
      return {
        ok: false,
        status: 404,
        headers: kind("text/plain"),
        text: async () => "Not Found",
      };
    if (next === "html")
      // An older Core: its web app answers every unknown path with its page.
      return {
        ok: true,
        status: 200,
        headers: kind("text/html; charset=utf-8"),
        text: async () => "<!doctype html><html></html>",
        json: async () => JSON.parse("<!doctype html>"),
      };
    if (next === 500)
      return {
        ok: false,
        status: 500,
        headers: kind("application/json"),
        text: async () => '{"error":"busy"}',
      };
    const body = JSON.stringify(next);
    return {
      ok: true,
      status: 200,
      headers: kind("application/json"),
      text: async () => body,
      json: async () => JSON.parse(body),
    };
  };
  w.eval(bundle);
  const d = w.document,
    f = w.connectionFixture;
  await until(
    () =>
      d.querySelector(".prose")?.textContent.includes("initial fixture reply"),
    "the app",
  );
  await until(() => state.reads > 0, "the first backlog read");
  /** One more read now (as when the window becomes visible again). */
  const read = async (next) => {
    state.next = next;
    const before = state.reads;
    d.dispatchEvent(new w.Event("visibilitychange"));
    await until(() => state.reads > before, "a backlog read");
    await pause(40);
  };
  const hint = () => d.querySelector(".statusbar .core-backlog-hint");
  return { w, d, f, state, read, hint, errors, close: () => w.close() };
}

test("a short spike shows nothing; staying behind shows a note with details, and it clears on catching up", async () => {
  const p = await mount();
  try {
    await p.read(backlog({ a: agentA(6000), b: agentA(0, 0) }));
    assert.ok(p.hint() === null, "one read at the threshold is not enough");
    await p.read(backlog({ a: agentA(300, 5), b: agentA(0, 0) }));
    assert.ok(p.hint() === null, "a burst that catches up never shows");

    await p.read(backlog({ a: agentA(6000), b: agentA(10, 1) }));
    await p.read(backlog({ a: agentA(11000), b: agentA(10, 1) }));
    assert.equal(
      p.hint()?.textContent,
      "Core is catching up on output; status may lag",
    );
    assert.equal(p.hint()?.getAttribute("aria-expanded"), "false");
    p.hint().click();
    await until(() => p.d.querySelector(".core-backlog-details"), "details");
    const details = p.d.querySelector(".core-backlog-details").textContent;
    assert.match(details, /Codex fixture · 42 events waiting · oldest 11 s/);
    assert.doesNotMatch(
      details,
      /Claude fixture/,
      "an Agent that keeps up is not listed",
    );
    assert.match(details, /Thinking and long-running tools are not counted/);
    assert.match(details, /Observed /);
    assert.equal(
      p.d.querySelector("[data-core-status]")?.dataset.coreStatus,
      "Core connected",
      "Core is not shown offline",
    );

    await p.read(backlog({ a: agentA(0, 0), b: agentA(0, 0) }));
    assert.ok(p.hint() === null, "caught up: the note goes away");
    assert.equal(
      p.f.calls.filter((c) => c.method !== "GET").length,
      0,
      "reading never writes or acts on an Agent",
    );
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a failed read, a closing connection or lost live updates make it unknown, never stale", async () => {
  const p = await mount();
  try {
    const behind = backlog({ a: agentA(8000) });
    await p.read(behind);
    await p.read(behind);
    assert.ok(p.hint() !== null);
    await p.read("offline");
    assert.ok(p.hint() === null, "no read: unknown");
    await p.read(behind);
    assert.ok(p.hint() === null, "a new streak starts after an unknown read");
    await p.read(behind);
    assert.ok(p.hint() !== null);
    await p.read(backlog({}));
    assert.ok(
      p.hint() === null,
      "the Agent's connection is gone: unknown, not behind",
    );

    await p.read(behind);
    await p.read(behind);
    assert.ok(p.hint() !== null);
    p.f.scenario("sse");
    await until(() => p.hint() === null, "live updates lost");
    const reads = p.state.reads;
    p.d.dispatchEvent(new p.w.Event("visibilitychange"));
    await pause(60);
    assert.equal(p.state.reads, reads, "no backlog reads without live updates");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

for (const [older, answer] of [
  ["its web app's page", "html"],
  ["404", 404],
]) {
  test(`an older Core that answers with ${older} is asked once`, async () => {
    const p = await mount(answer);
    try {
      assert.equal(p.state.reads, 1);
      p.d.dispatchEvent(new p.w.Event("visibilitychange"));
      await pause(60);
      assert.equal(p.state.reads, 1, "an unsupported route is not asked again");
      assert.ok(p.hint() === null);
      assert.deepEqual(p.errors, []);
    } finally {
      p.close();
    }
  });
}

test("a read still out when the window is hidden is dropped; visible again starts afresh", async () => {
  const p = await mount();
  let hidden = false;
  Object.defineProperty(p.d, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  try {
    const behind = backlog({ a: agentA(8000) });
    await p.read(behind);
    await p.read(behind);
    assert.ok(p.hint() !== null);

    // A read goes out, then the window is hidden before it answers.
    p.state.held = true;
    const before = p.state.reads;
    p.d.dispatchEvent(new p.w.Event("visibilitychange"));
    await until(() => p.state.reads > before, "a read in flight");
    hidden = true;
    p.d.dispatchEvent(new p.w.Event("visibilitychange"));
    await until(() => p.hint() === null, "hidden: forgotten at once");
    p.state.held = false;
    p.state.release();
    await pause(60);
    assert.ok(p.hint() === null, "the late answer is not written back");

    // Visible again: counting starts from zero.
    hidden = false;
    await p.read(behind);
    assert.ok(p.hint() === null, "one read is a new streak");
    await p.read(behind);
    assert.ok(p.hint() !== null);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a server error is unknown for now and asked again", async () => {
  const p = await mount(500);
  try {
    const behind = backlog({ a: agentA(8000) });
    await p.read(behind);
    await p.read(behind);
    assert.ok(p.hint() !== null, "reading resumed after the error");
    await p.read(500);
    assert.ok(p.hint() === null, "unknown, not stale");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
