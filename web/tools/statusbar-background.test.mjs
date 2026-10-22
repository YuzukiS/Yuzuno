import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM } from "jsdom";

// The status bar's background work (T-82): Core's review and CI lists are
// history pages, newest first, so a review or run still going can sit past
// the first page; and a job can end while another starts, leaving the
// running-plus-queued total unchanged. Neither may drop out of the count or
// lose its end notice; ends told at once each get their turn. Core lists CI
// runs in the order it first recorded them, not GitHub's (T-92).
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "node_modules/.cache"), { recursive: true });
const temp = await mkdtemp(path.join(root, "node_modules/.cache/statusbar-background-"));
let bundle;
try {
  const entry = path.join(temp, "entry.tsx");
  await writeFile(
    entry,
    `import React, {useEffect} from 'react';import {createRoot} from 'react-dom/client';
import {useBackground} from ${JSON.stringify(path.join(root, "src/StatusBar.tsx"))};
window.notices=[];
function Probe({revision}){const b=useBackground(revision,true);const text=b.notice?b.notice.text:null;useEffect(()=>{if(text)window.notices.push({text,more:b.more})},[text]);useEffect(()=>{if(b.budget)window.reads=(window.reads||0)+1},[b.budget]);window.counts={reviews:b.reviews,ci:b.ci,partial:!!b.ciPartial};return null}
const root=createRoot(document.getElementById('root'));
window.show=(revision)=>root.render(<Probe revision={String(revision)}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    mode: "development",
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": '"development"' },
    build: { write: false, minify: false, lib: { entry, name: "StatusBarBackgroundTests", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((v) => v.type === "chunk").code;
} finally {
  await rm(temp, { recursive: true, force: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, what, ms = 3000) {
  for (let i = 0; i < ms / 10; i++) {
    if (f()) return;
    await sleep(10);
  }
  assert.fail(`Expected: ${what}`);
}
// StatusBar.tsx's own delays: the read that answers a burst of events, and an
// end notice's turn while another waits. Only these exact delays run faster
// here, every other one as given; each test checks they were the ones set,
// so a changed delay fails instead of being waited out.
const READ_MS = 400;
const TURN_MS = 4000;
const FASTER = new Map([[READ_MS, 40], [TURN_MS, 400]]);
// The read the last show() started has been answered and rendered, and all
// it told logged: every read sets a fresh budget, which the Probe counts
// after the notices of the same render.
async function readDone(l, what) {
  await until(() => (l.w.reads ?? 0) >= l.shows, `${what}: read ${l.shows} answered and rendered`);
}
// One read delay per show(), each run through its faster stand-in.
function delaysRan(l, turns = 0) {
  assert.equal(l.fired.get(READ_MS), l.shows, `the ${READ_MS} ms read delay ran once per show()`);
  if (turns) assert.equal(l.fired.get(TURN_MS), turns, `the ${TURN_MS} ms notice turn ran ${turns} times`);
}
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;
const budget = {
  machine: { name: "Core host", memoryAvailableMiB: 8000 },
  budget: { cpuMillis: 4000, memoryMiB: 8192 },
  reserved: { cpuMillis: 1000, memoryMiB: 1024 },
  activeCount: 1,
  queuedCount: 0,
};
const review = (id, status, createdAt, extra = {}) => ({
  id, taskId: "T-1", number: 7, status, conclusion: null, createdAt, finishedAt: null, ...extra,
});
const run = (id, status, createdAt, extra = {}) => ({ id, name: "CI", status, createdAt, updatedAt: createdAt, runWatched: true, ...extra });
const subscription = (id, agentId, taskId, active = true, watch = {}) => ({
  id, agentId, taskId, active, watch: { observedAt: ago(60_000), state: "watching", ...watch },
});
const PAGE = 50;
// Core's CI list (ci_list, core/src/ci_monitor/store.rs): the runs linked to
// a subscription in scope (`subs` here), by the cursor Core gave each when
// it first recorded it, newest first, 50 a page; every page also lists the
// newest 200 subscriptions in scope (newest first here), active or not, and
// counts the active ones.
function ciList(ci = { runs: [] }, u) {
  const agentId = u.searchParams.get("agentId");
  const taskId = u.searchParams.get("taskId");
  const before = u.searchParams.get("before");
  const subs = (ci.subscriptions ?? []).filter((s) => (!agentId || s.agentId === agentId) && (!taskId || s.taskId === taskId));
  const ids = new Set(subs.map((s) => s.id));
  const runs = ci.runs
    .filter((r) => (r.subs ?? []).some((id) => ids.has(id)) && (before === null || r.cursor < Number(before)))
    .sort((a, b) => b.cursor - a.cursor);
  const page = runs.slice(0, PAGE).map(({ subs: _, ...r }) => r);
  const hasMore = runs.length > PAGE;
  return {
    runs: page,
    hasMore,
    nextBefore: hasMore ? page.at(-1).cursor : null,
    ...(ci.unlisted
      ? {}
      : {
          subscriptions: subs.slice(0, 200),
          subscriptionsTruncated: subs.length > 200,
          activeSubscriptionCount: subs.filter((s) => s.active).length,
        }),
  };
}
// The lab: Core's answers by path and page, and every request made.
function lab(f) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  w.fetch = async (url) => {
    calls.push(url);
    const u = new URL(url, "http://isolated.test");
    const before = u.searchParams.get("before");
    const page = (pages) => pages[before ?? "first"] ?? { hasMore: false, nextBefore: null };
    const job = f.job && u.pathname.startsWith("/api/jobs/") && f.job[decodeURIComponent(u.pathname.slice(10))];
    const v =
      u.pathname === "/api/jobs/budget" ? budget
      : u.pathname === "/api/jobs" ? { jobs: f.jobs ?? [], liveJobs: f.liveJobs ?? [], hasMore: false, nextBefore: null }
      : job ? job
      : u.pathname === "/api/reviews" ? page(f.reviews)
      : u.pathname === "/api/ci" ? ciList(f.ci, u)
      : null;
    if (!v) return { ok: false, status: 404, json: async () => ({ error: "not in fixture" }), text: async () => "" };
    return { ok: true, status: 200, json: async () => structuredClone(v) };
  };
  const fired = new Map([...FASTER.keys()].map((ms) => [ms, 0]));
  const windowTimeout = w.setTimeout;
  w.setTimeout = (handler, ms, ...args) =>
    typeof handler === "function" && FASTER.has(ms)
      ? windowTimeout.call(w, (...a) => (fired.set(ms, fired.get(ms) + 1), handler(...a)), FASTER.get(ms), ...args)
      : windowTimeout.call(w, handler, ms, ...args);
  w.eval(bundle);
  const l = { dom, w, calls, fired, shows: 0 };
  const show = w.show;
  w.show = (revision) => {
    l.shows++;
    show(revision);
  };
  return l;
}

test("a review or run still going past the first page is counted, its end told once; older pages are not read", async () => {
  const newer = Array.from({ length: 20 }, (_, i) => review(`rv${i}`, "completed", ago(10 * 60_000), { conclusion: "no_findings", finishedAt: ago(HOUR) }));
  const newerRuns = Array.from({ length: 50 }, (_, i) => run(`ci${i}`, "passed", ago(HOUR), { cursor: 600 - i, subs: ["done"] }));
  const f = {
    reviews: {
      first: { reviews: newer, hasMore: true, nextBefore: 100 },
      100: { reviews: [review("old", "running", ago(2 * HOUR))], hasMore: true, nextBefore: 80 },
      80: { reviews: [review("older", "completed", ago(30 * HOUR), { finishedAt: ago(29 * HOUR) })], hasMore: true, nextBefore: 60 },
    },
    ci: {
      runs: [...newerRuns, run("ci-old", "running", ago(3 * 24 * HOUR), { cursor: 500, subs: ["s1"] })],
      subscriptions: [subscription("done", "dev", "T-1", false), subscription("s1", "dev", "T-2")],
    },
  };
  const l = lab(f);
  try {
    l.w.show(1);
    await until(() => l.w.counts?.reviews === 1 && l.w.counts.ci === 1, "1 review and 1 run going");
    // Past a day nothing can still be going: the page before 60 is never read.
    assert.ok(!l.calls.some((c) => c.includes("before=60")), JSON.stringify(l.calls));
    // Copied out of the page's realm: deepEqual compares prototypes.
    assert.deepEqual([...l.w.notices], [], "what ended before the page looked is not news");
    // Both end, still behind a full page of newer history.
    f.reviews[100].reviews = [review("old", "completed", ago(2 * HOUR), { conclusion: "no_findings", finishedAt: ago(1000) })];
    f.ci.runs[50] = run("ci-old", "failed", ago(3 * 24 * HOUR), { updatedAt: ago(1000), cursor: 500, subs: ["s1"] });
    l.w.show(2);
    await until(() => l.w.counts.reviews === 0 && l.w.counts.ci === 0, "both ended");
    // Both ended in one read: each is told in turn, the first saying one more waits.
    await until(() => l.w.notices.length === 2, "two end notices, one after the other");
    const told = [...l.w.notices].map((n) => ({ ...n }));
    assert.deepEqual(told.map((n) => n.text).sort(), ["CI run failed", "Review of PR #7: no findings"]);
    assert.deepEqual(told.map((n) => n.more), [1, 0]);
    // Nothing followed now: the next read stays on the first pages and tells nothing again.
    const from = l.calls.length;
    l.w.show(3);
    await until(() => l.calls.length >= from + 4, "the next read");
    await readDone(l, "the next read");
    assert.ok(!l.calls.slice(from).some((c) => c.includes("before=")), JSON.stringify(l.calls.slice(from)));
    assert.equal(l.w.notices.length, 2);
    delaysRan(l, 1);
  } finally {
    l.dom.window.close();
  }
});

test("a job that ends as another starts is told, read on its own when off the first page", async () => {
  const f = { jobs: [], liveJobs: [{ id: "long", name: "long-check", status: "running", finishedAt: null }] };
  const l = lab(f);
  try {
    l.w.show(1);
    await until(() => l.calls.includes("/api/jobs"), "the first read");
    await readDone(l, "the first read");
    // The total stays at one: "long" ended and "next" took its place.
    f.liveJobs = [{ id: "next", name: "next-check", status: "running", finishedAt: null }];
    f.jobs = [{ id: "next", name: "next-check", status: "running", finishedAt: null }];
    f.job = { long: { id: "long", name: "long-check", status: "succeeded", finishedAt: ago(500) } };
    l.w.show(2);
    await until(() => l.w.notices.some((n) => n.text === "Job long-check finished"), "the end of long-check");
    assert.ok(l.calls.includes("/api/jobs/long"));
    // Told once.
    l.w.show(3);
    await readDone(l, "the next read");
    assert.equal(l.w.notices.filter((n) => n.text === "Job long-check finished").length, 1);
    delaysRan(l);
  } finally {
    l.dom.window.close();
  }
});

test("unwatched CI leaves the active count without a false completion notice", async () => {
  const f = {
    reviews: { first: { reviews: [], hasMore: false } },
    ci: {
      runs: [
        run("historical", "running", ago(3 * HOUR), { runWatched: false, cursor: 2, subs: ["old"] }),
        run("current", "running", ago(HOUR), { runWatched: true, cursor: 1, subs: ["now"] }),
      ],
      subscriptions: [subscription("old", "dev", "T-1", false), subscription("now", "dev", "T-2")],
    },
  };
  const l = lab(f);
  try {
    l.w.show(1);
    await until(() => l.w.counts?.ci === 1, "only the watched run is active");
    assert.equal(l.w.notices.length, 0);

    f.ci.runs[1].runWatched = false;
    l.w.show(2);
    await until(() => l.w.counts.ci === 0, "stopping monitoring removes the active count");
    assert.equal(l.w.notices.length, 0, "stopping is not completion");

    // A later exact refresh reveals two terminal facts. Only the run that
    // actually ended since this page opened is new; an old ending is silent.
    f.ci.runs[0] = run("historical", "cancelled", ago(3 * HOUR), {
      runWatched: false, updatedAt: ago(2 * HOUR), cursor: 2, subs: ["old"],
    });
    f.ci.runs[1] = run("current", "cancelled", ago(HOUR), {
      runWatched: false, updatedAt: new Date().toISOString(), cursor: 1, subs: ["now"],
    });
    l.w.show(3);
    await until(() => l.w.notices.length === 1, "the actual new cancellation is shown");
    assert.equal(l.w.notices[0].text, "CI run cancelled");
    assert.equal(l.w.counts.ci, 0);
    assert.ok(!l.calls.some((url) => url.startsWith("/api/ci/")), "status bar only reads cached lists");
    delaysRan(l);
  } finally {
    l.dom.window.close();
  }
});

// Every CI list request one read made, by the read it belongs to.
const ciCalls = (calls, from = 0) => calls.slice(from).filter((c) => c === "/api/ci" || c.startsWith("/api/ci?"));
const oldRuns = (n, top, subs) =>
  Array.from({ length: n }, (_, i) => run(`old${top - i}`, "passed", ago(30 * 24 * HOUR), { cursor: top - i, subs }));

test("a run going below a late-watched commit's old runs is counted, and its end told", async () => {
  // A commit watched today brought its month-old runs into Core's list
  // above a run that is going now.
  const f = {
    reviews: { first: { reviews: [], hasMore: false } },
    ci: {
      runs: [...oldRuns(50, 300, ["late"]), run("current", "running", ago(HOUR), { cursor: 250, subs: ["now"] })],
      subscriptions: [subscription("late", "dev", "T-9"), subscription("now", "dev", "T-8"), subscription("done", "lead", "T-1", false)],
    },
  };
  const l = lab(f);
  try {
    l.w.show(1);
    await until(() => l.w.counts?.ci === 1, "the run going is counted");
    assert.equal(l.w.counts.partial, false, "every active subscription's runs were read");
    // Found through the subscriptions' own lists, not by paging the whole history.
    assert.ok(ciCalls(l.calls).includes("/api/ci?agentId=dev&taskId=T-8"), JSON.stringify(l.calls));
    assert.ok(!ciCalls(l.calls).some((c) => c.includes("lead")), "an inactive subscription is not searched");
    // It fails; Core's newest page still holds only the old runs.
    f.ci.runs[50] = run("current", "failed", ago(HOUR), { cursor: 250, updatedAt: ago(500), subs: ["now"] });
    const from = l.calls.length;
    l.w.show(2);
    await until(() => l.w.notices.some((n) => n.text === "CI run failed"), "its end is told");
    assert.equal(l.w.counts.ci, 0);
    // Read from the page that starts at it, by its cursor.
    assert.ok(ciCalls(l.calls, from).includes("/api/ci?before=251"), JSON.stringify(l.calls.slice(from)));
    delaysRan(l);
  } finally {
    l.dom.window.close();
  }
});

test("a followed run pushed off the newest page by a late watch keeps its count and its end is told", async () => {
  const f = {
    reviews: { first: { reviews: [], hasMore: false } },
    ci: {
      runs: [run("current", "running", ago(HOUR), { cursor: 100, subs: ["now"] })],
      subscriptions: [subscription("now", "dev", "T-8")],
    },
  };
  const l = lab(f);
  try {
    l.w.show(1);
    await until(() => l.w.counts?.ci === 1, "the run going is counted");
    // Sixty old runs of a commit watched late come in above it.
    f.ci.runs.push(...oldRuns(60, 160, ["late"]));
    f.ci.subscriptions.unshift(subscription("late", "dev", "T-9"));
    l.w.show(2);
    await until(() => ciCalls(l.calls).filter((c) => c === "/api/ci").length >= 2, "the second read");
    await readDone(l, "the second read");
    assert.equal(l.w.counts.ci, 1, "still counted while still going");
    assert.equal(l.w.counts.partial, false);
    f.ci.runs[0] = run("current", "passed", ago(HOUR), { cursor: 100, updatedAt: ago(500), subs: ["now"] });
    l.w.show(3);
    await until(() => l.w.notices.some((n) => n.text === "CI run passed"), "its end is told");
    assert.equal(l.w.counts.ci, 0);
    l.w.show(4);
    await readDone(l, "the next read");
    assert.equal(l.w.notices.filter((n) => n.text === "CI run passed").length, 1, "told once");
    delaysRan(l);
  } finally {
    l.dom.window.close();
  }
});

test("a read asks for a bounded number of pages; what it could not reach is shown as maybe more", async () => {
  // The active subscription is older than the 200 listed (renewed, say), so
  // Core's whole list is all there is to read: 400 runs, recent ones, one
  // going on top and one at its far end.
  const recentRuns = Array.from({ length: 398 }, (_, i) => run(`r${i}`, "passed", ago(HOUR), { cursor: 1000 - i, subs: ["s"] }));
  const f = {
    reviews: { first: { reviews: [], hasMore: false } },
    ci: {
      runs: [
        run("top", "running", ago(HOUR), { cursor: 1001, subs: ["s"] }),
        ...recentRuns,
        run("far", "running", ago(HOUR), { cursor: 10, subs: ["s"] }),
      ],
      subscriptions: [...Array.from({ length: 200 }, (_, i) => subscription(`old${i}`, "lead", `T-${i}`, false)), subscription("s", "dev", "T-8")],
    },
  };
  const l = lab(f);
  try {
    l.w.show(1);
    await until(() => l.w.counts?.ci === 1, "the run on the pages read is counted");
    await readDone(l, "the first read");
    const first = ciCalls(l.calls);
    assert.ok(first.length <= 6, `at most 6 CI pages in a read, not ${first.length}: ${JSON.stringify(first)}`);
    assert.equal(l.w.counts.partial, true, "the count may leave out runs past the pages read");
    // Later reads stay as bounded and keep saying so.
    const from = l.calls.length;
    l.w.show(2);
    await until(() => l.calls.length >= from + 4, "the next read");
    await readDone(l, "the next read");
    assert.ok(ciCalls(l.calls, from).length <= 6, JSON.stringify(ciCalls(l.calls, from)));
    assert.equal(l.w.counts.ci, 1);
    assert.equal(l.w.counts.partial, true);
    delaysRan(l);
  } finally {
    l.dom.window.close();
  }
});

test("a followed run past the pages a read may ask for stays counted, never taken for ended", async () => {
  // Older Cores send no subscriptions: Core's list is read down to the
  // newest run seen before.
  const f = {
    reviews: { first: { reviews: [], hasMore: false } },
    ci: {
      runs: [run("current", "running", ago(HOUR), { cursor: 1, subs: ["s"] })],
      subscriptions: [subscription("s", "dev", "T-8")],
      unlisted: true,
    },
  };
  const l = lab(f);
  try {
    l.w.show(1);
    await until(() => l.w.counts?.ci === 1, "counted");
    assert.equal(l.w.counts.partial, false, "Core's whole list was read");
    // 400 runs come in above it at once; it is still going.
    f.ci.runs.push(...Array.from({ length: 400 }, (_, i) => run(`n${i}`, "passed", ago(HOUR), { cursor: 1000 - i, subs: ["s"] })));
    const from = l.calls.length;
    l.w.show(2);
    await until(() => ciCalls(l.calls, from).length >= 1, "the second read");
    await readDone(l, "the second read");
    assert.ok(ciCalls(l.calls, from).length <= 6, JSON.stringify(ciCalls(l.calls, from)));
    // Its own page was read by its cursor, so it is known still going.
    assert.ok(ciCalls(l.calls, from).includes("/api/ci?before=2"), JSON.stringify(ciCalls(l.calls, from)));
    assert.equal(l.w.counts.ci, 1);
    assert.equal(l.w.notices.length, 0, "not taken for ended");
    // The pages between were not all read, so newer runs may be missing.
    assert.equal(l.w.counts.partial, true);
    delaysRan(l);
  } finally {
    l.dom.window.close();
  }
});

test("a read overtaken by a newer one changes nothing; a failed read keeps what was known", async () => {
  const f = {
    reviews: { first: { reviews: [], hasMore: false } },
    ci: {
      runs: [run("current", "running", ago(HOUR), { cursor: 1, subs: ["s"] })],
      subscriptions: [subscription("s", "dev", "T-8")],
    },
  };
  const l = lab(f);
  const fetch = l.w.fetch;
  try {
    l.w.show(1);
    await until(() => l.w.counts?.ci === 1, "counted");
    // The next CI read fails part way: nothing it read is kept.
    l.w.fetch = async (url, init) => (url.startsWith("/api/ci") ? { ok: false, status: 500, json: async () => ({}), text: async () => "down" } : fetch(url, init));
    f.ci.runs[0] = run("current", "failed", ago(HOUR), { cursor: 1, updatedAt: ago(500), subs: ["s"] });
    l.w.show(2);
    await readDone(l, "the failed read");
    assert.equal(l.w.counts.ci, 1, "still the last count");
    assert.equal(l.w.notices.length, 0);
    // Back: the end is told once.
    l.w.fetch = fetch;
    l.w.show(3);
    await until(() => l.w.notices.some((n) => n.text === "CI run failed"), "told when Core answers again");
    l.w.show(4);
    await readDone(l, "the next read");
    assert.equal(l.w.notices.filter((n) => n.text === "CI run failed").length, 1);
    delaysRan(l);
  } finally {
    l.dom.window.close();
  }
});

test("a subscription with more runs than a read may ask for is searched on from where the last read stopped", async () => {
  // 300 runs of one task, the one going at the far end of its list.
  const many = Array.from({ length: 300 }, (_, i) => run(`m${i}`, "passed", ago(HOUR), { cursor: 400 - i, subs: ["s"] }));
  const f = {
    reviews: { first: { reviews: [], hasMore: false } },
    ci: {
      runs: [...many, run("far", "running", ago(HOUR), { cursor: 1, subs: ["s"] })],
      subscriptions: [subscription("s", "dev", "T-8")],
    },
  };
  const l = lab(f);
  try {
    l.w.show(1);
    await until(() => ciCalls(l.calls).length >= 6, "the first read");
    await readDone(l, "the first read");
    assert.equal(ciCalls(l.calls).length, 6, JSON.stringify(ciCalls(l.calls)));
    assert.equal(l.w.counts.ci, 0);
    assert.equal(l.w.counts.partial, true, "not every run of the subscription was read");
    const from = l.calls.length;
    l.w.show(2);
    await until(() => l.w.counts.ci === 1, "found when the search goes on");
    assert.equal(l.w.counts.partial, false);
    // From where it stopped, not from the newest again.
    const next = ciCalls(l.calls, from);
    assert.deepEqual(next, ["/api/ci", "/api/ci?agentId=dev&taskId=T-8&before=151", "/api/ci?agentId=dev&taskId=T-8&before=101"]);
    delaysRan(l);
  } finally {
    l.dom.window.close();
  }
});

test("a long-used workspace with more than 200 subscriptions, nearly all ended, still reads whole", async () => {
  // 250 subscriptions; only the newest is active. Its run going sits far
  // down Core's list, past 300 runs of others.
  const others = Array.from({ length: 300 }, (_, i) => run(`o${i}`, "passed", ago(HOUR), { cursor: 1000 - i, subs: [`old${i % 249}`] }));
  const f = {
    reviews: { first: { reviews: [], hasMore: false } },
    ci: {
      runs: [...others, run("mine", "running", ago(HOUR), { cursor: 5, subs: ["now"] })],
      subscriptions: [subscription("now", "dev", "T-8"), ...Array.from({ length: 249 }, (_, i) => subscription(`old${i}`, "lead", `T-${i}`, false))],
    },
  };
  const l = lab(f);
  try {
    l.w.show(1);
    await until(() => l.w.counts?.ci === 1, "the run going is counted");
    assert.equal(l.w.counts.partial, false, "every active subscription is listed and was searched");
    assert.ok(ciCalls(l.calls).length <= 2, JSON.stringify(ciCalls(l.calls)));
    l.w.show(2);
    await readDone(l, "the next read");
    assert.equal(l.w.counts.partial, false);
    f.ci.runs[300] = run("mine", "passed", ago(HOUR), { cursor: 5, updatedAt: ago(500), subs: ["now"] });
    l.w.show(3);
    await until(() => l.w.notices.some((n) => n.text === "CI run passed"), "its end is told");
    assert.equal(l.w.counts.ci, 0);
    assert.equal(l.w.counts.partial, false, "nothing going and nothing unread: no CI item");
    delaysRan(l);
  } finally {
    l.dom.window.close();
  }
});
