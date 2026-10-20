import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "pr-reviews-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {PrReviews} from ${JSON.stringify(path.join(root, "src/PrReviews.tsx"))};
import {ReviewSettings} from ${JSON.stringify(path.join(root, "src/ReviewSettings.tsx"))};
const root = createRoot(document.getElementById('root'));
window.renderReviews = props => root.render(<PrReviews {...props}/>);
window.renderSettings = props => root.render(<ReviewSettings {...props}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: {
      write: false,
      lib: { entry, name: "ImportUI", formats: ["iife"] },
    },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (item) => item.type === "chunk",
  ).code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

function mount(handler) {
  const calls = [],
    errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://isolated.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  dom.window.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body });
    const result = await handler(url, body, init);
    if (result instanceof Error) throw result;
    return {
      ok: true,
      status: 200,
      json: async () => structuredClone(result),
      text: async () => JSON.stringify(result),
    };
  };
  dom.window.eval(bundle);
  return {
    window: dom.window,
    doc: dom.window.document,
    calls,
    errors,
    close: () => dom.window.close(),
  };
}
const link = {
  id: "7:pull:1",
  kind: "pull",
  repository: "owner/repo",
  number: 1,
  snapshot: { baseSha: "a".repeat(40), headSha: "b".repeat(40) },
};
const run = {
  id: "run-1",
  requestId: "accepted",
  linkId: link.id,
  repository: link.repository,
  number: 1,
  status: "completed",
  requestedHarness: "claude",
  requestedModel: "default",
  actualHarness: "claude",
  actualModel: "native-model",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  mergeBaseSha: "c".repeat(40),
  conclusion: "no_findings",
  error: null,
  createdAt: new Date().toISOString(),
  outdated: true,
  findings: [],
  round: 2,
};
const page = (reviews) => ({
  reviews,
  settings: { harness: "codex", model: "gpt-6.1-sol" },
  hasMore: false,
  nextBefore: null,
});
const button = (p, text) =>
  [...p.doc.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === text,
  );
async function waitFor(f) {
  for (let i = 0; i < 100; i++) {
    if (f()) return;
    await tick();
  }
  assert.fail("Expected UI state did not appear");
}

test("lost start reply retries the same request and fixed version, then renders retained report", async () => {
  let attempts = 0,
    reviews = [];
  const p = mount((url, body) => {
    if (url === "/api/pr-reviews" && body) {
      attempts++;
      if (attempts === 1) return new Error("Response lost");
      reviews = [{ ...run, requestId: body.requestId }];
      return reviews[0];
    }
    if (url.includes("/run-1?"))
      return { ...reviews[0], rawReport: "original native evidence" };
    return page(reviews);
  });
  try {
    p.window.renderReviews({ taskId: "T-1", links: [link], disabled: false });
    await waitFor(
      () => button(p, "Review PR") && !button(p, "Review PR").disabled,
    );
    button(p, "Review PR").click();
    await waitFor(
      () =>
        p.doc.querySelector('[role="alert"]') &&
        !button(p, "Review PR").disabled,
    );
    button(p, "Review PR").click();
    await waitFor(() => p.doc.body.textContent.includes("Review ID: run-1"));
    const starts = p.calls.filter((c) => c.url === "/api/pr-reviews");
    assert.equal(starts.length, 2);
    assert.equal(starts[0].body.requestId, starts[1].body.requestId);
    assert.equal(starts[0].body.baseSha, link.snapshot.baseSha);
    assert.equal(starts[0].body.headSha, link.snapshot.headSha);
    assert.doesNotMatch(p.doc.body.textContent, /Outdated report/);
    assert.match(p.doc.body.textContent, /Claude Code · native-model/);
    const summary = [...p.doc.querySelectorAll("summary")].find(
      (s) => s.textContent === "Original report",
    );
    summary.parentElement.open = true;
    await waitFor(
      () =>
        p.doc.querySelector("pre")?.textContent === "original native evidence",
    );
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
test("cancel addresses the same task/run and late task responses do not leak", async () => {
  let release;
  const pending = new Promise((r) => (release = r));
  const p = mount((url, body) => {
    if (url.includes("/cancel")) return { cancellationRequested: true };
    if (url.includes("T-old")) return pending;
    return page([{ ...run, status: "running", phase: "Reviewing" }]);
  });
  try {
    p.window.renderReviews({ taskId: "T-old", links: [link], disabled: false });
    await tick();
    p.window.renderReviews({ taskId: "T-new", links: [link], disabled: false });
    await waitFor(() => button(p, "Cancel review"));
    button(p, "Cancel review").click();
    await waitFor(() => p.calls.some((c) => c.url.endsWith("/cancel")));
    assert.deepEqual(p.calls.find((c) => c.url.endsWith("/cancel")).body, {
      taskId: "T-new",
    });
    release(page([{ ...run, id: "wrong-task" }]));
    await tick();
    await tick();
    assert.doesNotMatch(p.doc.body.textContent, /wrong-task/);
  } finally {
    p.close();
  }
});
test("periodic refresh preserves older pages, expanded reports and the oldest pagination boundary", async () => {
  let reviews = Array.from({ length: 60 }, (_, i) => ({
    ...run,
    id: `run-${60 - i}`,
    cursor: 60 - i,
    status: i === 0 ? "running" : "completed",
    phase: "Reviewing",
  }));
  const p = mount((url) => {
    if (url.includes("/run-23?"))
      return { ...run, id: "run-23", rawReport: "older original evidence" };
    const query = new URL(url, "http://isolated.test").searchParams;
    if (query.get("taskId") === "T-new")
      return page([{ ...run, id: "another-task", cursor: 100 }]);
    const before = Number(query.get("before") || Infinity);
    const remaining = reviews.filter((r) => r.cursor < before);
    const visible = remaining.slice(0, 20);
    return {
      ...page(visible),
      hasMore: remaining.length > visible.length,
      nextBefore: visible.at(-1)?.cursor ?? null,
    };
  });
  const timers = new Map();
  let timerId = 0;
  p.window.setInterval = (callback, delay) => {
    timers.set(++timerId, { callback, delay });
    return timerId;
  };
  p.window.clearInterval = (id) => timers.delete(id);
  const refresh = (delay) => {
    assert.equal(timers.size, 1);
    const timer = [...timers.values()][0];
    assert.equal(timer.delay, delay);
    timer.callback();
  };
  const articles = () => [...p.doc.querySelectorAll("article")];
  const article = (id) =>
    articles().find((el) =>
      [...el.querySelectorAll("small")].some(
        (small) => small.textContent === `Review ID: ${id}`,
      ),
    );
  try {
    p.window.renderReviews({ taskId: "T-1", links: [link], disabled: false });
    await waitFor(() => articles().length === 20);
    button(p, "Older reviews").click();
    await waitFor(() => articles().length === 40);
    const older = article("run-23");
    const report = [...older.querySelectorAll("summary")].find(
      (s) => s.textContent === "Original report",
    ).parentElement;
    report.open = true;
    await waitFor(() => report.textContent.includes("older original evidence"));

    reviews = [62, 61].map((cursor) => ({ ...run, id: `run-${cursor}`, cursor }))
      .concat(reviews.map((r) => ({ ...r, status: "completed" })));
    refresh(1500);
    await waitFor(() => article("run-62") && !button(p, "Cancel review"));
    assert.equal(articles().length, 42);
    assert.equal(article("run-23"), older);
    assert.equal(report.open, true);
    assert.match(report.textContent, /older original evidence/);

    // A second refresh must neither duplicate rows nor reset the old cursor.
    const callsBeforeRefresh = p.calls.length;
    refresh(5000);
    await waitFor(() => p.calls.length > callsBeforeRefresh);
    await tick();
    assert.equal(articles().length, 42);
    assert.equal(report.open, true);
    button(p, "Older reviews").click();
    await waitFor(() => article("run-1"));
    assert.ok(p.calls.some((c) => c.url.endsWith("&before=21")));
    assert.equal(articles().length, 62);
    assert.equal(button(p, "Older reviews"), undefined);

    refresh(5000);
    await tick();
    assert.equal(articles().length, 62);
    assert.equal(button(p, "Older reviews"), undefined);
    assert.equal(report.open, true);
    p.window.renderReviews({ taskId: "T-new", links: [link], disabled: false });
    await waitFor(() => article("another-task"));
    assert.equal(articles().length, 1);
    assert.doesNotMatch(p.doc.body.textContent, /older original evidence/);
    assert.equal(button(p, "Older reviews"), undefined);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
test("retained older reports follow current PR revisions and preserve unverified semantics", async () => {
  const reviews = Array.from({ length: 45 }, (_, i) => ({
    ...run,
    id: `run-${45 - i}`,
    cursor: 45 - i,
    outdated: false,
    baseSha: 45 - i === 25 ? null : run.baseSha,
    headSha: 45 - i === 24 ? null : run.headSha,
  }));
  const p = mount((url) => {
    if (url.includes("/run-23?"))
      return { ...reviews.find((r) => r.id === "run-23"), rawReport: "older revision evidence" };
    const before = Number(new URL(url, "http://isolated.test").searchParams.get("before") || Infinity);
    const remaining = reviews.filter((r) => r.cursor < before);
    const visible = remaining.slice(0, 20);
    return {
      ...page(visible),
      hasMore: remaining.length > visible.length,
      nextBefore: visible.at(-1)?.cursor ?? null,
    };
  });
  const article = (id) =>
    [...p.doc.querySelectorAll("article")].find((el) =>
      [...el.querySelectorAll("small")].some(
        (small) => small.textContent === `Review ID: ${id}`,
      ),
    );
  let revision = 0;
  const showRevision = async (snapshot, stale = false) => {
    const firstPageCalls = () => p.calls.filter((c) => c.url === "/api/pr-reviews?taskId=T-1").length;
    const before = firstPageCalls();
    p.window.renderReviews({
      taskId: "T-1",
      links: snapshot ? [{ ...link, snapshot, stale, syncedAt: String(++revision) }] : [],
      disabled: false,
    });
    await waitFor(() => firstPageCalls() > before);
    await tick();
  };
  try {
    await showRevision(link.snapshot);
    button(p, "Older reviews").click();
    await waitFor(() => article("run-23"));
    const older = article("run-23");
    const report = [...older.querySelectorAll("summary")].find(
      (s) => s.textContent === "Original report",
    ).parentElement;
    report.open = true;
    await waitFor(() => report.textContent.includes("older revision evidence"));
    const check = (outdated, unverified) => {
      assert.equal(article("run-23"), older);
      assert.equal(report.open, true);
      assert.match(report.textContent, /older revision evidence/);
      assert.equal(older.textContent.includes("Outdated report"), outdated);
      assert.equal(older.textContent.includes("Latest PR revision is unverified"), unverified);
      assert.equal(p.doc.querySelectorAll("article").length, 40);
      assert.ok(button(p, "Older reviews"));
    };
    check(false, false);
    await showRevision({ ...link.snapshot, headSha: "d".repeat(40) });
    check(true, false);
    await showRevision(link.snapshot);
    check(false, false);
    await showRevision({ ...link.snapshot, baseSha: "e".repeat(40) });
    check(true, false);
    // Missing frozen or current revisions are unknown, never a false match.
    for (const id of ["run-24", "run-25"]) {
      assert.match(article(id).textContent, /Latest PR revision is unverified/);
      assert.doesNotMatch(article(id).textContent, /Outdated report/);
    }
    await showRevision({ headSha: link.snapshot.headSha });
    check(false, true);
    await showRevision({ baseSha: link.snapshot.baseSha });
    check(false, true);
    await showRevision(null);
    check(false, true);
    await showRevision(link.snapshot, true);
    check(false, true);
    await showRevision({ ...link.snapshot, headSha: "d".repeat(40) }, true);
    check(true, true);
    await showRevision(link.snapshot);
    check(false, false);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
test("settings use native model catalog and save only an explicit choice", async () => {
  let settings = { harness: "codex", model: "gpt-6.1-sol" };
  const p = mount((url, body) => {
    if (url.includes("/models?"))
      return {
        models: [
          {
            id: "current",
            model: "current",
            displayName: "Current native model",
          },
        ],
      };
    if (body) settings = body;
    return settings;
  });
  try {
    p.window.renderSettings({ active: true });
    await waitFor(() => p.doc.querySelector('[aria-label="Review Harness"]'));
    const select = p.doc.querySelector('[aria-label="Review Harness"]');
    select.value = "claude";
    select.dispatchEvent(new p.window.Event("change", { bubbles: true }));
    await waitFor(() =>
      p.doc.body.textContent.includes("Current native model"),
    );
    assert.equal(p.calls.filter((c) => c.body).length, 0);
    button(p, "Save review settings").click();
    await waitFor(() => p.calls.some((c) => c.body));
    assert.deepEqual(p.calls.find((c) => c.body).body, {
      harness: "claude",
      model: "current",
    });
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
test("a link opens one older review with its original report, without paging or starting anything", async () => {
  const p = mount((url) => {
    if (url.startsWith("/api/pr-reviews/run-old?"))
      return {
        ...run,
        id: "run-old",
        cursor: 1,
        round: 1,
        status: "failed",
        conclusion: "unknown",
        rawReport: "kept original output",
      };
    if (url.startsWith("/api/pr-reviews?"))
      return { ...page([{ ...run, cursor: 40 }]), hasMore: true, nextBefore: 40 };
    if (url.includes("peers_list")) return { peers: [] };
    return page([]);
  });
  try {
    p.window.HTMLElement.prototype.scrollIntoView = function () {
      p.window.scrolled = this.className;
    };
    p.window.renderReviews({
      taskId: "task-one",
      links: [link],
      disabled: false,
      focusReviewId: "run-old",
    });
    await waitFor(() => p.doc.querySelector(".pr-review-run.focused"));
    const focused = p.doc.querySelector(".pr-review-run.focused");
    assert.match(focused.textContent, /Review ID: run-old/);
    assert.equal(focused.querySelector("details:last-of-type").open, true);
    assert.equal(focused.querySelector("pre").textContent, "kept original output");
    assert.equal(p.doc.querySelectorAll(".pr-review-run").length, 2);
    assert.match(
      p.doc.querySelectorAll(".pr-review-run")[1].textContent,
      /run-old/,
      "older than the loaded page, it sorts after it",
    );
    assert.equal(p.window.scrolled, "pr-review-run focused");
    assert.ok(button(p, "Older reviews"), "page boundary unchanged");
    assert.equal(
      p.calls.filter((c) => c.url.startsWith("/api/pr-reviews/run-old?")).length,
      1,
    );
    assert.equal(p.calls.some((c) => c.url.includes("before=")), false);
    assert.equal(p.calls.some((c) => c.body && !c.url.includes("peers_list")), false);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("context reads are named by their tool; only a read with an error is failed, and no version is invented", async () => {
  const head = "b".repeat(40);
  const contextReads = [
    // Three successful reads that name no single file (T-82 review 5803bc8f).
    { tool: "review_changes", number: 1, requested: { cursor: 0 }, totalFiles: 31, nextCursor: null, comparison: `${"c".repeat(40)}..${head}` },
    { tool: "source_paths", number: 2, requested: { cursor: 0, query: "pr-reviews", revision: "head" }, revision: head, nextCursor: null },
    { tool: "source_search", number: 3, requested: { query: "contextReads", pathPrefix: "web/src", revision: "head" }, revision: head, query: "contextReads", pathPrefix: "web/src", searchedFilesThisPage: 8, skipped: [] },
    { tool: "source_diff", number: 4, path: "web/src/PrReviews.tsx", revision: head, offset: 0, endOffset: 900, totalBytes: 900 },
    // A real failure keeps its error; it has no fixed revision.
    { tool: "source_read", number: 5, error: "Line range is outside the file", kind: "invalid_arguments", requested: { path: "web/src/App.tsx", startLine: 9000, endLine: 9100, revision: "head" }, coverageIncomplete: true },
    // Retained before receipts named their tool.
    { path: "web/src/api.ts", revision: head, blobSha: "d".repeat(40) },
    { path: "web/src/old.ts" },
  ];
  const p = mount((url) => {
    if (url.startsWith("/api/pr-reviews?")) return page([{ ...run, outdated: false, contextReads }]);
    if (url.includes("peers_list")) return { peers: [] };
    return page([]);
  });
  try {
    p.window.renderReviews({ taskId: "task-one", links: [link], disabled: false });
    await waitFor(() => p.doc.querySelector(".pr-review-run"));
    const reads = [...p.doc.querySelectorAll(".pr-review-run details")]
      .find((details) => /context reads/.test(details.querySelector("summary").textContent));
    assert.ok(reads, "the context reads are listed");
    assert.equal(reads.querySelector("summary").textContent, "7 context reads · 1 failed");
    const rows = [...reads.querySelectorAll("p")].map((row) => row.textContent);
    assert.deepEqual(rows, [
      "Changed files (31) · cccccccc..bbbbbbbb",
      'Path list matching "pr-reviews" · bbbbbbbb',
      'Search "contextReads" in web/src · bbbbbbbb',
      "Diff web/src/PrReviews.tsx, bytes 0–900 of 900 · bbbbbbbb",
      "Source web/src/App.tsx · Failed: Line range is outside the file",
      "web/src/api.ts · bbbbbbbb",
      "web/src/old.ts",
    ]);
    assert.ok(!rows.some((row) => /Read failed|Pending/.test(row)), "no success is shown as failed, no version as pending");
    const failed = [...reads.querySelectorAll("p.github-error")].map((row) => row.textContent);
    assert.deepEqual(failed, ["Source web/src/App.tsx · Failed: Line range is outside the file"]);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("stored approvals keep suggestions visible and unknown reports expose reasons", async () => {
  const suggestion = { title: "Optional cleanup", body: "Keep this note", path: "a.ts", startLine: 1, endLine: 1, revision: "b".repeat(40), priority: 3 };
  const reviews = [
    { ...run, id: "approved", conclusion: "approved_with_notes", policyVersion: 2, reasonCodes: [], findings: [suggestion],
      coverage: { version: 2, fileCount: 2, coveredFileCount: 2, deliveredCompleteDiffs: 1, fullAddedSourceCount: 1 } },
    { ...run, id: "uncertain", conclusion: "unknown", policyVersion: 2, reasonCodes: ["coverage_incomplete", "unsupported_source"], findings: [] },
    { ...run, id: "legacy", conclusion: "unknown", findings: [suggestion] },
  ];
  const p = mount(() => page(reviews));
  try {
    p.window.renderReviews({ taskId: "T-1", links: [link], disabled: false });
    await waitFor(() => p.doc.body.textContent.includes("Some source cannot be inspected"));
    assert.match(p.doc.body.textContent, /Passed · non-blocking suggestions/);
    assert.match(p.doc.body.textContent, /Keep this note/);
    assert.match(p.doc.body.textContent, /Review coverage is incomplete/);
    const articles = [...p.doc.querySelectorAll("article")];
    assert.equal(articles.filter(a => a.textContent.includes("Passed · non-blocking suggestions")).length, 1);
    assert.equal(articles.filter(a => a.textContent.includes("Conclusion unknown")).length, 2);
    assert.match(articles.find(a => a.textContent.includes("Passed · non-blocking suggestions")).textContent,
      /2 of 2 files covered · 1 by complete diff · 1 by complete added-file source/);
    assert.equal(articles.filter(a => a.textContent.includes("files covered")).length, 1);
  } finally { p.close(); }
});

test("a continuation names the round it continues and the reads of each round", async () => {
  const reviews = [
    { ...run, id: "child", round: 2, kind: "continuation", conclusion: "no_findings", policyVersion: 3, reasonCodes: [],
      continuation: { parentReviewId: "parent", parentRound: 1, targets: [{ path: "b.rs", state: "not_read" }] },
      coverage: { version: 3, fileCount: 3, coveredFileCount: 3, deliveredCompleteDiffs: 2, fullAddedSourceCount: 0, inheritedCoveredCount: 1 } },
    { ...run, id: "parent", round: 1, conclusion: "unknown", policyVersion: 3, reasonCodes: ["coverage_incomplete"],
      coverage: { version: 3, fileCount: 3, coveredFileCount: 1, deliveredCompleteDiffs: 1, fullAddedSourceCount: 0 } },
  ];
  const p = mount(() => page(reviews));
  try {
    p.window.renderReviews({ taskId: "T-1", links: [link], disabled: false });
    await waitFor(() => p.doc.querySelector(".pr-review-continuation"));
    const [child, parent] = [...p.doc.querySelectorAll("article")];
    assert.match(child.querySelector("header strong").textContent, /Round 2 · continues round 1$/);
    assert.match(child.textContent, /3 of 3 files covered · 2 by complete diff · 0 by complete added-file source · 1 read by round 1/);
    assert.equal(child.querySelector(".pr-review-continuation").textContent,
      "Continues round 1 for the 1 path it left unread: a new reviewer run with its own cost, within what that round left of its budget. Coverage and conclusion are over both rounds; that round's findings are kept as it recorded them.");
    assert.equal(parent.querySelector(".pr-review-continuation"), null);
    assert.doesNotMatch(parent.textContent, /continues round|read by round/);
  } finally { p.close(); }
});

test("an incremental round names the earlier round, what it read again and what it settled", async () => {
  const reviews = [
    { ...run, id: "now", round: 2, kind: "incremental", conclusion: "no_findings", policyVersion: 3, reasonCodes: [],
      incremental: { previousReviewId: "earlier", previousRound: 1, targets: [{ path: "b.rs", why: "changed" }], carriedPaths: ["a.rs", "c.rs"], leftThePr: [] },
      settledFindings: [{ title: "Bug", body: "Fixed", priority: 1, path: "b.rs", startLine: 1, endLine: 1 }],
      coverage: { version: 3, fileCount: 3, coveredFileCount: 3, deliveredCompleteDiffs: 1, fullAddedSourceCount: 0, inheritedCoveredCount: 2 } },
    { ...run, id: "earlier", round: 1, conclusion: "changes_requested", policyVersion: 3, reasonCodes: [],
      coverage: { version: 3, fileCount: 3, coveredFileCount: 3, deliveredCompleteDiffs: 3, fullAddedSourceCount: 0 } },
  ];
  const p = mount(() => page(reviews));
  try {
    p.window.renderReviews({ taskId: "T-1", links: [link], disabled: false });
    await waitFor(() => p.doc.querySelector(".pr-review-incremental"));
    const [now, earlier] = [...p.doc.querySelectorAll("article")];
    assert.match(now.querySelector("header strong").textContent, /Round 2 · new head after round 1$/);
    assert.match(now.textContent, /3 of 3 files covered · 1 by complete diff · 0 by complete added-file source · 2 unchanged since round 1/);
    assert.equal(now.querySelector(".pr-review-incremental").textContent,
      "Reviews a new head after round 1: it reads the 1 path that changed or wasn't read before, and keeps that round's proofs only for paths identical on both sides. A new round with its own budget and cost. That round's findings stay unless this one shows them fixed by its own reads (1 settled).");
    assert.equal(earlier.querySelector(".pr-review-incremental"), null);
    assert.doesNotMatch(earlier.textContent, /new head after round|unchanged since round/);
  } finally { p.close(); }
});

test("a review's scope names every path it couldn't cover and why; older reviews show none", async () => {
  const blob = (c) => c.repeat(40);
  const head = (c) => ({ blobSha: blob(c), mode: "100644" });
  const scope = {
    version: 1,
    counts: { covered: 1, excluded: 1, unsupported: 2, budget_exhausted: 2, read_failed: 1, not_read: 1 },
    policy: { state: "valid", path: ".yuzuno/review-scope.json", revision: "a".repeat(40), rules: [{ path: "vendor/prebuilt/**", reason: "Release job output" }] },
    paths: [
      { path: "core/ok.rs", state: "covered", head: head("1"), facts: [{ kind: "covered", evidenceKind: "complete_diff" }] },
      { path: "helper/helper.exe", state: "unsupported", reason: "binary", head: head("2"), facts: [{ kind: "unsupported", side: "head", reason: "binary" }, { kind: "not_read" }] },
      { path: "vendor/sub", state: "unsupported", reason: "submodule", head: { blobSha: blob("3"), mode: "160000" }, facts: [{ kind: "unsupported", side: "head", reason: "submodule" }] },
      { path: "vendor/prebuilt/lib.so", state: "excluded", head: head("8"),
        facts: [{ kind: "excluded", rule: "vendor/prebuilt/**", reason: "Release job output" }, { kind: "unsupported", side: "head", reason: "binary" }] },
      { path: "data/huge.txt", state: "budget_exhausted", reason: "diff_exceeds_context", head: head("4"), facts: [{ kind: "budget_exhausted", reason: "diff_exceeds_context", totalDiffBytes: 2_400_000 }] },
      { path: "web/late.ts", state: "budget_exhausted", reason: "context_exhausted", head: head("5"), facts: [{ kind: "budget_exhausted", reason: "context_exhausted" }, { kind: "not_read" }] },
      { path: "web/broken.ts", state: "read_failed", mergeBase: head("6"), facts: [{ kind: "read_failed", requests: [{ receipt: 3 }] }] },
      { path: "web/half.ts", state: "not_read", head: head("7"), facts: [{ kind: "not_read", remainingByteRanges: [[12000, 30000]] }] },
    ],
  };
  const evidence = [
    { id: "e1", path: "helper/helper.exe", kind: "artifact_hash", reference: { ciRunKey: "github:7:39297617576:1" }, artifactSha256: "e".repeat(64),
      artifactMatchesHeadContent: true, note: "Built by the release job", registeredBy: { name: "Dev 2" }, binding: "this_candidate" },
    { id: "e0", path: "helper/helper.exe", kind: "build_provenance", reference: { url: "https://github.com/owner/repo/actions/runs/1" },
      registeredBy: { name: "Dev 2" }, candidate: { headSha: "d".repeat(40) }, binding: "other_candidate" },
  ];
  const reviews = [
    { ...run, id: "scoped", conclusion: "unknown", policyVersion: 3, reasonCodes: ["coverage_incomplete", "unsupported_source", "diff_too_large", "scope_excluded"],
      coverage: { version: 3, fileCount: 8, coveredFileCount: 1, deliveredCompleteDiffs: 1, fullAddedSourceCount: 0 }, scope, evidence,
      scopeConclusion: "no_findings" },
    { ...run, id: "older", conclusion: "unknown", policyVersion: 2, reasonCodes: ["coverage_incomplete"],
      coverage: { version: 2, fileCount: 2, coveredFileCount: 1, deliveredCompleteDiffs: 1, fullAddedSourceCount: 0 } },
  ];
  const p = mount(() => page(reviews));
  try {
    p.window.renderReviews({ taskId: "T-1", links: [link], disabled: false });
    await waitFor(() => p.doc.querySelector(".pr-review-scope"));
    const articles = [...p.doc.querySelectorAll("article")];
    const scoped = articles.find((a) => a.querySelector(".pr-review-scope"));
    assert.equal(p.doc.querySelectorAll(".pr-review-scope").length, 1, "the older review has no scope section");
    assert.equal(scoped.querySelector(".pr-review-scope summary").textContent,
      "Review scope · 1 of 8 changed paths covered · 1 excluded by policy · 2 can't be reviewed as text · 2 over budget · 1 read failed · 1 not read");
    assert.match(scoped.textContent, /Scope policy \.yuzuno\/review-scope\.json at base aaaaaaaa: 1 exclusion rule\. Excluded paths stay unreviewed and the review doesn't pass\./);
    assert.match(scoped.textContent, /Some paths can't be reviewed as text at this head or are excluded, so no round of it can be complete\./);
    assert.match(scoped.textContent, /Within the policy's scope: No actionable findings\. Shown for information; the review's own conclusion stands\./);
    assert.match(scoped.textContent, /Conclusion unknown/);
    assert.deepEqual([...scoped.querySelectorAll('[aria-label="Paths outside the review"] li')].map((li) => li.textContent), [
      "helper/helper.exe · can't be reviewed as text (binary file) · blob 22222222",
      "vendor/sub · can't be reviewed as text (submodule, never followed) · blob 33333333",
      "vendor/prebuilt/lib.so · excluded by policy (rule vendor/prebuilt/**; also binary file) · blob 88888888",
      "data/huge.txt · over budget (its complete diff is larger than any review can read, 2.4 MB) · blob 44444444",
      "web/late.ts · over budget (the review's budget ran out first) · blob 55555555",
      "web/broken.ts · read failed (context read 3) · blob 66666666",
      "web/half.ts · not read (partly read) · blob 77777777",
    ]);
    assert.ok(!scoped.querySelector('[aria-label="Paths outside the review"]').textContent.includes("core/ok.rs"), "covered paths aren't listed");
    assert.deepEqual([...scoped.querySelectorAll('[aria-label="Registered evidence"] li')].map((li) => li.textContent), [
      "helper/helper.exe · Artifact hash · CI run 39297617576 · registered SHA-256 eeeeeeeeeeee equals the reviewed head content's · bound to this candidate (identity match) · registered by Dev 2; Core didn't fetch or verify the reference · Author's note: Built by the release job",
      "helper/helper.exe · Build provenance · https://github.com/owner/repo/actions/runs/1 · from another candidate (head dddddddd); doesn't apply here · registered by Dev 2; Core didn't fetch or verify the reference",
    ]);
    assert.match(scoped.textContent, /1 of 8 files covered · 1 by complete diff/);
    assert.match(scoped.textContent, /A changed file's complete diff is larger than any review can read/);
    assert.match(scoped.textContent, /excluded by the base's scope policy and stay unreviewed/);
    assert.match(articles.find((a) => a !== scoped).textContent, /1 of 2 files covered/);
  } finally { p.close(); }
});
