import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

// Home's other machines (YN-83 S1) against an in-memory Core: /api/machine-live
// is its own read, at most one request in flight, only while the machine card
// is expanded and the page visible. No real Core, SSH, or registered machine.
const distUrl = process.env.YUZUNO_UI_DIST
  ? pathToFileURL(resolve(process.env.YUZUNO_UI_DIST) + "/")
  : new URL("../dist/", import.meta.url);
const index = await readFile(new URL("index.html", distUrl), "utf8");
const entry = index.match(/src="\/(assets\/[^" ]+\.js)"/)?.[1];
assert.ok(entry, "index.html must name the current JavaScript bundle");
const bundle = await uiTestBundle(new URL(entry, distUrl));
const pause = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, message, seconds = 6) {
  const deadline = Date.now() + seconds * 1000;
  while (!predicate() && Date.now() < deadline) await pause(10);
  assert.ok(predicate(), message);
}

// The read is fast enough to see several polls without long sleeps: one real
// millisecond is 50 ms of the page's monotonic clock and its timers.
const SPEED = 50;
const at = (seconds = 0) => new Date(Date.now() + seconds * 1000).toISOString();
const machine = (extra) => ({
  id: "m",
  name: "m",
  state: "online",
  code: null,
  since: at(0),
  retryAt: null,
  observedAt: at(0),
  platform: "Linux",
  sameAs: null,
  load: null,
  ...extra,
});
const load = (extra = {}) => ({
  cpu: { pct: 23, cores: 32, observedAt: at(0) },
  memory: { totalMiB: 64307, usedMiB: 12698, availableMiB: 50176, estimate: false, observedAt: at(0) },
  disks: [{ roles: ["root"], totalMiB: 953674, availableMiB: 421888, observedAt: at(0), error: null, permanent: null }],
  gpu: { state: "off", code: "not_enabled" },
  ...extra,
});
const machineLoad = () => ({
  at: at(0),
  cpu: { cores: 16, totalPct: 42, jobsPct: 10, agentsPct: null, otherPct: null },
  memory: { totalMiB: 65536, usedMiB: 32000, availableMiB: 33536, jobsMiB: 2048, agentsMiB: null },
  gpus: null,
  jobs: [],
});
const agents = [
  {
    id: "mori", name: "Mori", harness: "codex", cwd: "/fixture", model: "test-model", settings: {}, color: "sage",
    createdAt: "", updatedAt: "", status: "idle", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, closedAt: null,
  },
];
const projects = [{ id: "p1", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const home = () => ({
  generatedAt: at(0),
  order: ["p1"],
  needsYou: [],
  projects: [
    {
      project: { id: "p1", name: "App" },
      agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
      errors: [],
      pending: [],
      jobs: [],
      unseen: 0,
      missing: [],
      brief: { version: 1, sections: [], history: [] },
    },
  ],
});

async function mount({ preview = false, rows = [], loadMode = "ok", mode = "ok" } = {}) {
  const calls = [];
  const errors = [];
  const logged = [];
  const pending = [];
  let aborts = 0;
  const state = { mode, rows, loadMode };
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  vc.on("error", (...args) => logged.push(args.map(String).join(" ")));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: preview ? "http://127.0.0.1:4317/?preview=1" : "http://127.0.0.1:4317/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const w = dom.window;
  // A scaled clock: the page's own timers and performance.now advance together,
  // so 2 s polls and the 6 s expiry happen without the test sleeping for them.
  const realNow = w.performance.now.bind(w.performance);
  const started = realNow();
  Object.defineProperty(w.performance, "now", { configurable: true, value: () => (realNow() - started) * SPEED });
  const realSetTimeout = w.setTimeout.bind(w);
  const realSetInterval = w.setInterval.bind(w);
  w.setTimeout = (fn, ms = 0, ...args) => realSetTimeout(fn, Math.max(0, ms / SPEED), ...args);
  w.setInterval = (fn, ms = 0, ...args) => realSetInterval(fn, Math.max(1, ms / SPEED), ...args);
  w.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  w.EventSource = class {
    addEventListener() {}
    close() {}
  };
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLElement.prototype.scrollTo = function () {};
  let visibility = "visible";
  Object.defineProperty(w.document, "visibilityState", { configurable: true, get: () => visibility });
  const respond = (value, status = 200) => {
    const text = JSON.stringify(value);
    return { ok: status === 200, status, json: async () => JSON.parse(text), text: async () => text };
  };
  const hold = (init, rejectOnAbort) =>
    new Promise((resolvePromise, rejectPromise) => {
      const entry = {
        resolve: (value) => resolvePromise(respond({ machines: value })),
        signal: init.signal,
      };
      pending.push(entry);
      if (rejectOnAbort)
        init.signal?.addEventListener("abort", () => rejectPromise(new w.DOMException("The operation was aborted.", "AbortError")));
    });
  w.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    init.signal?.addEventListener("abort", () => aborts++);
    if (url.endsWith("/api/workspace"))
      return respond({ workspace: { id: "ws-live" }, projects, agents, runtime: { connected: true }, defaultCwd: "/w" });
    if (url.endsWith("/api/home")) return respond(home());
    if (url.endsWith("/api/machine-load")) {
      if (state.loadMode === "fail") return respond({ error: "connection lost" }, 503);
      return respond(machineLoad());
    }
    if (url.endsWith("/api/machine-live")) {
      if (state.mode === "fail") return respond({ error: "connection lost" }, 503);
      if (state.mode === "invalid") return respond({});
      if (state.mode === "hold") return hold(init, true);
      if (state.mode === "hold-ignore-abort") return hold(init, false);
      return respond({ machines: state.rows });
    }
    if (url.endsWith("/api/machines")) return respond({ machines: [] });
    if (url.endsWith("/api/updates")) return respond(unmanagedUpdates);
    if (url.endsWith("/api/jobs/budget")) return respond(idleJobsBudget);
    if (url.endsWith("/api/jobs")) return respond(noJobs);
    if (url.endsWith("/api/jobs/live")) return respond(noLiveJobs);
    if (url.endsWith("/api/ci/live")) return respond({ agents: {} });
    if (url.endsWith("/api/ci")) return respond(noCiRuns);
    if (url.endsWith("/api/reviews")) return respond(noReviews);
    if (url.endsWith("/api/backlog")) return respond({ observedAt: at(0), agents: {} });
    if (url.endsWith("/api/models")) return respond({ models: [] });
    const detail = /\/api\/agents\/(\w+)$/.exec(url);
    if (detail) {
      const agent = agents.find((a) => a.id === detail[1]);
      return respond({ agent, pending: [], artifacts: [], messageReceipts: [], turns: [] });
    }
    return respond({});
  };
  const doc = w.document;
  const button = (text) => [...doc.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(text));
  const openAgent = () =>
    [...doc.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Open Mori"));
  w.eval(bundle);
  {
    const deadline = Date.now() + 6000;
    const read = () => button("Home") && /Mori/.test(doc.querySelector(".agent-list")?.textContent || "");
    while (!read() && Date.now() < deadline) await pause(10);
    if (!read())
      throw new Error(
        `the workspace is read: calls=${JSON.stringify(calls.map((c) => c.url))} errors=${JSON.stringify(errors)} logged=${JSON.stringify(logged)} body=${JSON.stringify(doc.body.textContent?.slice(0, 600))}`,
      );
  }
  button("Home").click();
  if (preview) await waitFor(() => doc.querySelector(".home-remote-row"), "the preview's machine rows");
  else await waitFor(() => doc.querySelector("[data-glance-project]"), "Home read its projects");
  const remote = () => doc.querySelector(".home-remote-machines");
  return {
    w, doc, calls, errors, logged, pending, state,
    remote,
    rows: () => [...doc.querySelectorAll(".home-remote-row")],
    texts: () => [...doc.querySelectorAll(".home-remote-row")].map((r) => r.textContent),
    setVisibility(value) {
      visibility = value;
      doc.dispatchEvent(new w.Event("visibilitychange"));
    },
    close() {
      w.close();
    },
    aborts: () => aborts,
    liveCalls: () => calls.filter((c) => c.url.endsWith("/api/machine-live")),
    loadCalls: () => calls.filter((c) => c.url.endsWith("/api/machine-load")),
  };
}

test("each live state and reading is drawn from /api/machine-live: platform, CPU, estimate, disk, GPU off, sameAs, retry and unclean reasons; no Jobs or Agents claim", async () => {
  const rows = [
    machine({ id: "m1", name: "build-box", load: load() }),
    machine({ id: "m2", name: "lab-mac", platform: "Darwin", sameAs: "m1", load: load({ memory: { totalMiB: 32768, usedMiB: 9318, availableMiB: 15237, estimate: true, observedAt: at(0) }, cpu: { pct: 8, cores: 10, observedAt: at(0) } }) }),
    machine({ id: "m3", name: "laptop", state: "connecting", platform: null }),
    machine({ id: "m4", name: "gpu-node", state: "offline", code: "ssh_unreachable", platform: null, retryAt: at(12) }),
    machine({ id: "m5", name: "lab-box", state: "unavailable", code: "unclean_exit", platform: null }),
    machine({ id: "m6", name: "nas", state: "idle", platform: null }),
  ];
  const p = await mount({ rows });
  try {
    await waitFor(() => p.rows().length === 6, "six other machines");
    const chips = p.rows().map((r) => r.querySelector(".home-remote-chip").textContent.trim());
    assert.deepEqual(chips, ["Online", "Online", "Connecting…", "Offline", "Unavailable", "Not connected"]);
    const row = (id) => p.doc.querySelector(`[data-machine-id="${id}"]`);
    const fact = (id, name) => row(id).querySelector(`[data-remote-fact="${name}"] strong`).textContent;
    assert.equal(fact("m1", "CPU"), "23% of 32 cores");
    assert.equal(fact("m1", "Memory"), "12.4 / 62.8 GiB");
    assert.equal(fact("m1", "Disk"), "412.0 GiB");
    assert.match(row("m1").querySelector('[data-remote-fact="GPU"]').textContent, /GPU\s*Not enabled/);
    assert.equal(row("m1").querySelector(".home-remote-name .home-remote-platform").textContent, "Linux");
    assert.equal(row("m2").querySelector(".home-remote-name .home-remote-platform").textContent, "macOS");
    assert.equal(row("m2").querySelector(".home-remote-tag").textContent, "estimated");
    assert.equal(row("m2").querySelector(".home-remote-tag").getAttribute("title"), null, "the explanation is a Tip, not a native title");
    assert.match(row("m2").querySelector(".home-remote-why").textContent, /build-box.*does not share this connection/);
    assert.match(row("m4").querySelector(".home-remote-why").textContent, /Automatic retry at/);
    const unclean = row("m5").querySelector(".home-remote-why").textContent;
    assert.match(unclean, /cannot confirm the remote program has exited/);
    assert.match(unclean, /does not reconnect automatically/);
    assert.match(unclean, /Live status is unavailable: check the connection on the Machines page/);
    assert.equal(row("m5").querySelector(".home-remote-check").tagName, "BUTTON");
    assert.equal(row("m4").querySelector(".home-remote-facts").textContent.trim(), "Live status is unavailable");
    assert.equal(row("m5").querySelector(".home-remote-facts").textContent.trim(), "Live status is unavailable");
    assert.match(row("m6").querySelector(".home-remote-why").textContent, /No session is open/);
    assert.deepEqual(
      [...row("m3").querySelectorAll(".home-fact strong")].map((e) => e.textContent),
      ["Reading…", "Reading…", "Reading…"],
      "connecting reads as reading, not unknown and not 0",
    );
    const text = p.remote().textContent;
    assert.doesNotMatch(text, /\bJobs?\b|\bAgents?\b/, "the card makes no Jobs or Agents claim");
    assert.doesNotMatch(text, /\bPR\s*\d|\bS[1-6]\b/, "no stage or PR name");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("more than six machines: six rows, then how many more; a null reading is unknown; an auth failure says why", async () => {
  const rows = [
    machine({ id: "m1", name: "one", load: load() }),
    machine({ id: "m2", name: "two", load: load() }),
    machine({ id: "m3", name: "three", load: load() }),
    machine({ id: "m4", name: "four", load: load() }),
    machine({ id: "m5", name: "five", load: load() }),
    machine({ id: "m6", name: "six", load: load() }),
    machine({ id: "m7", name: "seven", load: load({ cpu: null, memory: null, disks: null }) }),
    machine({ id: "m8", name: "eight", state: "unavailable", code: "ssh_auth", platform: null }),
  ];
  const p = await mount({ rows });
  try {
    await waitFor(() => p.rows().length === 6, "only six rows");
    assert.equal(p.doc.querySelector(".home-remote-more").textContent, "2 more · Show them on the Machines page");
    assert.equal(p.doc.querySelector('[data-machine-id="m7"]'), null, "the seventh is not drawn");
    assert.equal(p.doc.querySelector('[data-machine-id="m8"]'), null, "the eighth is not drawn");
    // The same list, without the cap, still resolves an unknown reading.
    p.state.rows = [machine({ id: "host", name: "host", load: load({ cpu: null, memory: null, disks: null }) })];
    await waitFor(() => p.rows().length === 1, "the cap follows the answer");
    assert.deepEqual(
      [...p.doc.querySelector('[data-machine-id="host"]').querySelectorAll(".home-fact strong")].map((e) => e.textContent),
      ["unknown", "unknown", "unknown"],
      "an online reading that is null is unknown, never 0",
    );
    p.state.rows = [machine({ id: "here", name: "also-here", sameAs: "local", load: load() })];
    await waitFor(() => p.doc.querySelector('[data-machine-id="here"]'), "the row with the same account as this host");
    assert.match(
      p.doc.querySelector('[data-machine-id="here"] .home-remote-why').textContent,
      /same host as this Core host.*does not share this connection/,
    );
    p.state.rows = [machine({ id: "auth", name: "auth", state: "unavailable", code: "ssh_auth", platform: null })];
    await waitFor(() => p.doc.querySelector('[data-machine-id="auth"]'), "the auth failure");
    assert.match(p.doc.querySelector('[data-machine-id="auth"] .home-remote-why').textContent, /SSH authentication failed.*not retry automatically/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("no successful answer for 6 s hides online and its values even while a request hangs, then a later answer restores them", async () => {
  const p = await mount({ rows: [machine({ id: "m1", name: "build-box", load: load() })] });
  try {
    await waitFor(() => p.rows()[0]?.querySelector(".home-remote-chip")?.textContent === "Online", "the first reading");
    p.state.mode = "hold";
    await waitFor(() => p.pending.length > 0, "the next poll held");
    await pause(140); // 7 s of the page's clock
    const status = p.doc.querySelector(".home-remote-status");
    assert.ok(status, "the card says it has no current answer");
    assert.match(status.textContent, /No answer for 6 seconds/);
    assert.match(status.textContent, /last answer /);
    assert.equal(p.rows()[0].querySelector(".home-remote-chip").textContent, "Unknown");
    assert.doesNotMatch(p.remote().textContent, /23%|12\.4 GiB|412\.0 GiB/, "no old online value is kept");
    assert.match(p.rows()[0].querySelector(".home-fact").textContent, /last /);
    p.state.mode = "ok";
    await waitFor(() => p.rows()[0]?.querySelector(".home-remote-chip")?.textContent === "Online", "a later answer restores online", 5);
    assert.equal(p.doc.querySelector(".home-remote-status"), null, "the failure line goes away");
    assert.match(p.remote().textContent, /23%/, "the values are back");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a first read that never answers becomes Unknown after 6 s, not Reading, and recovers; further timeouts keep it Unknown", async () => {
  const p = await mount({ rows: [machine({ id: "m1", name: "build-box", load: load() })], mode: "hold" });
  try {
    await waitFor(() => p.pending.length > 0, "the first request held");
    assert.match(p.remote().textContent, /Reading the other machines/);
    await pause(140); // 7 s of the page's clock: the first read never answered
    const status = p.doc.querySelector(".home-remote-status");
    assert.ok(status, "a first hung read is not Reading for ever");
    assert.match(status.textContent, /No answer for 6 seconds/);
    assert.doesNotMatch(p.remote().textContent, /Reading the other machines/);
    assert.equal(p.rows().length, 0, "no machine names are known yet");
    // A consecutive timeout leaves it Unknown; it does not go back to Reading.
    p.state.mode = "hold";
    await waitFor(() => p.pending.length > 1, "the next request held", 5);
    await pause(140);
    assert.ok(p.doc.querySelector(".home-remote-status"), "still no answer, still said");
    assert.doesNotMatch(p.remote().textContent, /Reading the other machines/);
    p.state.mode = "ok";
    await waitFor(() => p.rows()[0]?.querySelector(".home-remote-chip")?.textContent === "Online", "a later answer restores online", 5);
    assert.equal(p.doc.querySelector(".home-remote-status"), null);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("an answer that is not {machines: []} is a failure, not no machines; existing rows stay unknown", async () => {
  const p = await mount({ rows: [machine({ id: "m1", name: "build-box", load: load() })], mode: "invalid" });
  try {
    await waitFor(() => p.doc.querySelector(".home-remote-status"), "the first invalid answer is a failure");
    assert.match(p.doc.querySelector(".home-remote-status").textContent, /could not be understood/);
    assert.doesNotMatch(p.remote().textContent, /No other machines/);
    assert.equal(p.rows().length, 0);
    // A valid answer, then an invalid one: the rows stay, as unknown.
    p.state.mode = "ok";
    await waitFor(() => p.rows()[0]?.querySelector(".home-remote-chip")?.textContent === "Online", "a valid answer", 5);
    p.state.mode = "invalid";
    await waitFor(() => p.doc.querySelector(".home-remote-status"), "the invalid answer after rows", 5);
    assert.equal(p.rows().length, 1, "the last valid rows are kept");
    assert.equal(p.rows()[0].querySelector(".home-remote-chip").textContent, "Unknown");
    assert.match(p.rows()[0].querySelector(".home-fact").textContent, /last /);
    p.state.mode = "ok";
    await waitFor(() => p.rows()[0]?.querySelector(".home-remote-chip")?.textContent === "Online", "a later valid answer", 5);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a null core count has no cores suffix and never reads null", async () => {
  const p = await mount({
    rows: [machine({ id: "m1", name: "build-box", load: load({ cpu: { pct: 23, cores: null, observedAt: at(0) } }) })],
  });
  try {
    await waitFor(() => p.rows().length === 1, "the reading");
    const cpu = p.doc.querySelector('[data-remote-fact="CPU"]').textContent.trim();
    assert.equal(cpu, "CPU 23%", "a null core count leaves the suffix out");
    assert.doesNotMatch(cpu, /null|cores|核/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("sameAs local says only the same host, never that the account or data folder is the same", async () => {
  const p = await mount({ rows: [machine({ id: "here", name: "also-here", sameAs: "local", load: load() })] });
  try {
    await waitFor(() => p.doc.querySelector('[data-machine-id="here"] .home-remote-why'), "the local note");
    const why = p.doc.querySelector('[data-machine-id="here"] .home-remote-why').textContent;
    assert.match(why, /same host as this Core host/);
    assert.doesNotMatch(why, /same account|same data folder/, "local sameAs is only the host id");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a failed read is unknown at once with its last answer; the local load keeps its own error and success, and the other way round", async () => {
  const p = await mount({ rows: [machine({ id: "m1", name: "build-box", load: load() })] });
  try {
    await waitFor(() => p.rows()[0]?.querySelector(".home-remote-chip")?.textContent === "Online", "the first reading");
    await waitFor(() => p.doc.querySelector(".home-machines .home-machine:not([aria-busy])"), "the local load");
    p.state.mode = "fail";
    await waitFor(() => p.doc.querySelector(".home-remote-status"), "the remote read fails");
    assert.match(p.doc.querySelector(".home-remote-status").textContent, /Other machines could not be read: connection lost/);
    assert.equal(p.rows()[0].querySelector(".home-remote-chip").textContent, "Unknown");
    // The local read is untouched: no error line, its own value still shown.
    assert.equal(p.doc.querySelector(".home-machines-at.is-error"), null);
    assert.match(p.doc.querySelector(".home-machines .home-load").textContent, /42%/);
    // Now the local read fails; the remote one recovers: they stay separate.
    p.state.mode = "ok";
    p.state.loadMode = "fail";
    await waitFor(() => p.doc.querySelector(".home-machines-at.is-error"), "the local load fails");
    assert.match(p.doc.querySelector(".home-machines-at.is-error").textContent, /Machine load is unavailable: connection lost/);
    await waitFor(() => p.rows()[0]?.querySelector(".home-remote-chip")?.textContent === "Online", "the remote read recovers", 5);
    assert.equal(p.doc.querySelector(".home-remote-status"), null, "the remote failure line is gone");
    assert.match(p.remote().textContent, /23%/, "the remote values are drawn again");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("hidden, folded and leaving Home stop the read and abort it; showing again starts from reading, never an old online value", async () => {
  const p = await mount({ rows: [machine({ id: "m1", name: "build-box", load: load() })] });
  try {
    await waitFor(() => p.rows()[0]?.querySelector(".home-remote-chip")?.textContent === "Online", "the first reading");
    p.state.mode = "hold";
    await waitFor(() => p.pending.length > 0, "a request to abort");
    p.setVisibility("hidden");
    await pause(30);
    const hidden = p.liveCalls().length;
    assert.ok(p.aborts() > 0, "the request in flight is aborted when the page is hidden");
    assert.equal(p.rows().length, 0, "nothing of the old reading is drawn while hidden");
    await pause(120); // more than a poll
    assert.equal(p.liveCalls().length, hidden, "no request while hidden");
    // Shown again: the card reads at once and starts as reading, not as the old online row.
    const before = p.pending.length;
    p.setVisibility("visible");
    await waitFor(() => /Reading the other machines/.test(p.doc.querySelector(".home-remote-machines")?.textContent ?? ""), "the new mount reads");
    assert.equal(p.rows().length, 0, "no stale online row flashes back");
    await waitFor(() => p.liveCalls().length > hidden, "showing the page reads at once");
    await waitFor(() => p.pending.length > before, "the new request");
    p.pending.at(-1).resolve([machine({ id: "m1", name: "build-box", load: load() })]);
    await waitFor(() => p.rows().length === 1, "the new answer is drawn");
    // Folded: no more reads; expanded: a read at once.
    p.state.mode = "ok";
    p.doc.querySelector(".home-machines .home-fold").click();
    await pause(30);
    const folded = p.liveCalls().length;
    await pause(120);
    assert.equal(p.liveCalls().length, folded, "a folded card reads no other machine");
    p.doc.querySelector(".home-machines .home-fold").click();
    await waitFor(() => p.liveCalls().length > folded, "expanding reads at once");
    // Leaving Home unmounts the card and stops the read.
    await waitFor(() => p.rows().length === 1, "online again");
    p.state.mode = "hold";
    await waitFor(() => p.pending.length > 0, "a request in flight");
    const open = [...p.doc.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith("Open Mori"));
    assert.ok(open, "the Agent can be opened");
    open.click();
    await waitFor(() => !p.doc.querySelector(".home-view"), "Home closes");
    const left = p.liveCalls().length;
    await pause(120);
    assert.equal(p.liveCalls().length, left, "no read after leaving Home");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("an answer from an earlier mount never reaches the new one: only the current answer is drawn", async () => {
  const p = await mount({ rows: [machine({ id: "old", name: "OLD", load: load() })] });
  try {
    await waitFor(() => p.rows().length === 1, "the first reading");
    p.state.mode = "hold-ignore-abort";
    await waitFor(() => p.pending.length > 0, "the request that will answer late");
    p.setVisibility("hidden");
    await pause(20);
    p.setVisibility("visible");
    await waitFor(() => p.pending.length > 1, "a request of the new mount");
    const late = p.pending[0];
    const current = p.pending.at(-1);
    current.resolve([machine({ id: "new", name: "NEW", load: load() })]);
    await waitFor(() => p.rows().length === 1 && p.rows()[0].dataset.machineId === "new", "the current answer");
    late.resolve([machine({ id: "old", name: "OLD", load: load() })]);
    await pause(30);
    assert.equal(p.rows().length, 1);
    assert.equal(p.rows()[0].dataset.machineId, "new", "the late answer did not replace the current view");
    assert.doesNotMatch(p.remote().textContent, /OLD/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("the read-only design preview shows a synthetic fixture and asks for no machine reading", async () => {
  const p = await mount({ preview: true });
  try {
    await waitFor(() => p.rows().length > 0, "the preview's machine rows");
    assert.equal(p.liveCalls().length, 0, "no /api/machine-live request in the preview");
    assert.equal(p.loadCalls().length, 0, "no /api/machine-load request in the preview");
    const text = p.remote().textContent;
    assert.match(text, /build-box/);
    assert.match(text, /lab-mac/);
    assert.match(text, /Connecting…/);
    assert.match(text, /Unavailable/);
    assert.match(text, /does not share this connection/);
    assert.equal(p.doc.querySelector(".home-remote-check")?.tagName, "SPAN", "the preview's check entry does not navigate");
    await pause(150);
    assert.equal(p.liveCalls().length, 0, "still no request after a poll would have run");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
