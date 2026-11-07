// YN-1: after a Core restart a local Claude Agent's conversation shows its
// recovery notice ("The last turn was still running…") once, however often
// the page reads it again: reconnects, resets and the Agent's state flipping
// between running, connected and offline. The built app against fixture HTTP
// and a stand-in event stream; no Core.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const distUrl = process.env.YUZUNO_UI_DIST
  ? pathToFileURL(resolve(process.env.YUZUNO_UI_DIST) + "/")
  : new URL("../dist/", import.meta.url);
const index = await readFile(new URL("index.html", distUrl), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)?.[1];
assert.ok(entry, "index.html must name the current JavaScript bundle");
const { uiTestBundle } = await import("./ui-test-bundle.mjs");
const bundle = await uiTestBundle(new URL(entry, distUrl));
const pause = (ms = 25) => new Promise((done) => setTimeout(done, ms));
async function waitFor(check, label, timeout = 5_000, why = () => "") {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (performance.now() > deadline) assert.fail(`${label} (not within ${timeout} ms) ${why()}`.trim());
    await pause(5);
  }
}

const base = {
  model: "test-model", color: "sage", cwd: "/work/app", createdAt: "2026-11-06", updatedAt: "2026-11-06",
  goal: "", unreadCount: 0, pendingCount: 0, lastSeq: 4, reviewedSeq: 4,
};
// As Core shows them after it started again: the Turn it was running when it stopped is still in progress.
const afterRestart = { status: "offline", connectionState: "disconnected" };
const connected = { status: "working", connectionState: "connected" };
const turn = (status) => ({
  id: "turn-1", status,
  items: [{ id: "u-1", type: "userMessage", content: [{ type: "text", text: "Merge the queue" }] }],
});

function mount(harness) {
  const state = { agent: { ...afterRestart }, turn: "inProgress", reads: 0, workspaceReads: 0, calls: [] };
  const agent = () => ({
    ...base, id: "a", name: "Dev 9", harness, ...state.agent,
    ...(harness === "claude" ? { claudeSessionId: "session-a" } : { threadId: "019a1234-5678-4321-aaaa-123456789abc" }),
  });
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4317/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.localStorage.setItem("yuzuno.selected.ws-1", JSON.stringify("a"));
  window.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.HTMLElement.prototype.scrollTo = function () {};
  Object.defineProperty(window.document, "hasFocus", { configurable: true, value: () => true });
  Object.defineProperty(window.document, "visibilityState", { configurable: true, value: "visible" });
  // Core's event stream, which the test speaks through: open, drop, resume, reset.
  const streams = [];
  window.EventSource = class {
    constructor(url) {
      this.url = url;
      streams.push(this);
    }
    close() {
      this.closed = true;
    }
    addEventListener() {}
  };
  const respond = (body) => {
    const text = JSON.stringify(body);
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
  };
  window.fetch = async (url, init = {}) => {
    state.calls.push(`${init.method ?? "GET"} ${url}`);
    if (url.endsWith("/api/workspace")) {
      state.workspaceReads++;
      return respond({ workspace: { id: "ws-1" }, projects: [], agents: [agent()], runtime: { connected: true }, defaultCwd: "/work" });
    }
    // The Agent's record, whole or a window of it (`?…`), as Core answers both.
    if (/\/api\/agents\/a(\?.*)?$/.test(url)) {
      state.reads++;
      return respond({ agent: agent(), pending: [], artifacts: [], messageReceipts: [], turns: [turn(state.turn)] });
    }
    if (url.endsWith("/api/catchup"))
      return respond({ generatedAt: "now", items: [], source: "records", coverage: { fromSeq: 0, toSeq: 4 } });
    if (url.endsWith("/api/home")) return respond({ generatedAt: "now", order: [], projects: [], needsYou: [] });
    if (url.endsWith("/models")) return respond({ models: [] });
    return respond({});
  };
  window.eval(bundle);
  const stream = () => streams.at(-1);
  const notices = () => window.document.querySelectorAll(".recovery-notice:not(.quota-resume-notice)").length;
  const say = (event) => stream().onmessage?.({ data: JSON.stringify(event), lastEventId: "" });
  const why = () => state.calls.slice(-12).join("; ");
  /** Core says to read everything again (a reconnect, a reset); resolves once the workspace was read again and drawn. */
  const reset = async () => {
    const before = state.workspaceReads;
    say({ type: "reset", reason: "open" });
    await waitFor(() => state.workspaceReads > before, "the workspace is read again after a reset", 5_000, why);
    await pause(150);
  };
  /** Core says the Agent changed (its connection or state); resolves once it was read again and drawn. */
  const changed = async () => {
    const before = state.reads;
    say({ type: "agent.changed", agentId: "a" });
    await waitFor(() => state.reads > before, "the Agent is read again after it changed", 5_000, why);
    await pause(150);
  };
  return { window, state, stream, streams, notices, reset, changed, errors, close: () => window.close() };
}

// A local Claude Agent's notice shares its place with the quota notice (QuotaResume.tsx), which a Codex Agent's
// does not: Codex is the control, through the reads and the stream's drops.
for (const harness of ["claude", "codex"]) {
  const flips = harness === "claude";
  test(`a ${harness} Agent's recovery notice shows once through any number of reads, reconnects${flips ? " and flips" : ""} (YN-1)`, async () => {
    const page = mount(harness);
    try {
      await waitFor(() => page.stream(), "the page opens Core's event stream");
      page.stream().onopen?.();
      await waitFor(() => page.notices() > 0, "the running Turn's recovery notice shows");
      assert.match(page.window.document.querySelector(".recovery-notice").textContent,
        /The last turn was still running when this agent’s connection ended/);
      // Core read again and again while the Agent stays as it was after the restart.
      for (let read = 1; read <= 6; read++) {
        await page.reset();
        assert.equal(page.notices(), 1, `one recovery notice after read ${read}`);
      }
      // The stream drops and comes back, as it does while Core restarts.
      for (let drop = 1; drop <= 2; drop++) {
        const old = page.stream();
        // CLOSED, as when Core went away: the page opens a new stream after REOPEN_MS (3 s).
        old.readyState = 2;
        old.onerror?.();
        await waitFor(() => page.stream() !== old, `a new stream is opened after drop ${drop}`, 8_000);
        page.stream().onopen?.();
        await page.reset();
        assert.equal(page.notices(), 1, `one recovery notice after the stream came back ${drop} time(s)`);
      }
      if (!flips) return;
      // The Agent's state flips: connected (no notice), its connection ended again (the notice), offline.
      for (let flip = 1; flip <= 3; flip++) {
        Object.assign(page.state.agent, connected);
        await page.changed();
        assert.equal(page.notices(), 0, `no recovery notice while connected (flip ${flip})`);
        Object.assign(page.state.agent, afterRestart);
        await page.changed();
        await page.reset();
        assert.equal(page.notices(), 1, `one recovery notice when its connection ended again (flip ${flip})`);
      }
      page.state.turn = "completed";
      await page.changed();
      await page.reset();
      assert.equal(page.notices(), 1, "one notice, now saying the session is offline");
      assert.match(page.window.document.querySelector(".recovery-notice").textContent, /This agent’s session isn’t connected/);
      Object.assign(page.state.agent, connected);
      await page.changed();
      assert.equal(page.notices(), 0, "none once connected");
      assert.deepEqual(page.errors, []);
    } finally {
      page.close();
    }
  });
}
