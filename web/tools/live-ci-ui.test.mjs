import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// Production Agent rows and CI store: isolated responses, no live Core.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "live-ci-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgentRailRow} from ${JSON.stringify(path.join(root, "src/AgentRailRow.tsx"))};
import {refreshLiveJobs, useAgentJobs} from ${JSON.stringify(path.join(root, "src/live-jobs.ts"))};
import {refreshLiveCI, clearLiveCI, useAgentCI} from ${JSON.stringify(path.join(root, "src/live-ci.ts"))};
const root = createRoot(document.getElementById('root'));
// A probe on the same per-Agent subscription the row uses counts the renders
// a store update causes for that Agent.
window.renders = {};
function Probe({ id }) { useAgentCI(id); window.renders[id] = (window.renders[id] || 0) + 1; return null; }
const select = () => {};
window.renderRows = rows => root.render(<>{rows.map(r => <React.Fragment key={r.agent.id}><AgentRailRow {...r} onSelect={select} selected={false}/><Probe id={r.agent.id}/></React.Fragment>)}</>);
window.refreshLiveJobs = refreshLiveJobs; window.refreshLiveCI=refreshLiveCI; window.clearLiveCI=clearLiveCI;`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: {
      write: false,
      lib: { entry, name: "LiveCIUI", formats: ["iife"] },
    },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (item) => item.type === "chunk",
  ).code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
async function waitFor(read, what) {
  for (let i = 0; i < 80; i++) {
    if (read()) return;
    await tick();
  }
  assert.fail(`Timed out waiting for ${what}`);
}

const agent = (id) => ({
  id,
  name: id,
  cwd: "/workspace",
  model: "test",
  color: "sage",
  status: "idle",
  createdAt: "now",
  updatedAt: "now",
  unreadCount: 0,
  pendingCount: 0,
  lastSeq: 0,
  reviewedSeq: 0,
});
function mount() {
  const calls = [],
    errors = [],
    replies = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://isolated.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  // Each read waits for the test to answer it, in any order.
  dom.window.fetch = (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    return new Promise((resolve, reject) => {
      replies.push((value) =>
        value instanceof Error
          ? reject(value)
          : resolve({
              ok: true,
              status: 200,
              json: async () => structuredClone(value),
              text: async () => JSON.stringify(value),
            }),
      );
    });
  };
  dom.window.eval(bundle);
  const rows = [
    { agent: agent("a"), statusLabel: "Ready", idle: true },
    {
      agent: { ...agent("b"), status: "waiting" },
      statusLabel: "Waiting",
      idle: false,
    },
    { agent: agent("c"), statusLabel: "Ready", idle: true },
  ];
  dom.window.renderRows(rows);
  const label = (id) =>
    dom.window.document.querySelector(`[data-agent-id="${id}"] .agent-runtime`)
      ?.textContent;
  return {
    window: dom.window,
    calls,
    errors,
    replies,
    rows,
    label,
    close: () => dom.window.close(),
  };
}

test("idle CI and Jobs coexist, unknown jobs stay Check job, runtime states win", async () => {
  const p = mount();
  const ci = (value) => {
    p.window.refreshLiveCI("w1");
    p.replies.shift()({ agents: value });
  };
  const jobs = (value) => {
    p.window.refreshLiveJobs("w1");
    p.replies.shift()({ agents: value });
  };
  try {
    ci({
      a: { running: 2, discovering: 0, check: 0 },
      b: { running: 1, discovering: 0, check: 0 },
    });
    await waitFor(() => p.label("a") === "Waiting · CI", "CI label");
    // One wait stays beside the name like "Waiting · Job"; only a combined
    // status takes its own line (data-combined).
    const combined = (id) =>
      p.window.document.querySelector(`[data-agent-id="${id}"] .agent-runtime`).hasAttribute("data-combined");
    assert.equal(combined("a"), false, "a lone CI wait is not moved below the name");
    assert.equal(p.label("c"), "Ready");
    for (const status of ["Working", "Needs you", "Compacting", "Closed"]) {
      p.rows[1].statusLabel = status;
      p.window.renderRows(p.rows);
      await waitFor(() => p.label("b") === status, status);
    }
    jobs({ a: { active: 2, unknown: 0 } });
    await waitFor(() => p.label("a") === "Waiting · Job / CI", "both");
    assert.equal(combined("a"), true, "two waits take their own line");
    const title = () =>
      p.window.document.querySelector('[data-agent-id="a"] .agent-select')
        .title;
    assert.match(title(), /2 jobs queued or running/);
    assert.match(title(), /2 GitHub Actions runs/);
    ci({ a: { running: 1, discovering: 0, check: 1 } });
    await waitFor(
      () => p.label("a") === "Waiting · Job / CI · Check CI",
      "a healthy run cannot hide another CI target needing a check",
    );
    assert.match(title(), /1 CI target needs checking/);
    ci({ a: { running: 0, discovering: 1, check: 1 } });
    await waitFor(() => /waiting for run discovery/.test(title()), "mixed discovery");
    assert.equal(p.label("a"), "Waiting · Job / CI · Check CI");
    ci({ a: { running: 2, discovering: 0, check: 0 } });
    jobs({ a: { active: 1, unknown: 1 } });
    await waitFor(
      () => p.label("a") === "Waiting · CI · Check job",
      "unknown job remains explicit",
    );
    assert.equal(combined("a"), true, "a wait and a check take their own line");
    assert.match(title(), /unknown outcome/);
    ci({ a: { running: 0, discovering: 0, check: 1 } });
    await waitFor(() => p.label("a") === "Check job / CI", "only unconfirmed");
    jobs({});
    ci({ a: { running: 0, discovering: 1, check: 0 } });
    await waitFor(() => p.label("a") === "Waiting · CI", "discovery");
    assert.match(title(), /waiting for run discovery/);
    assert.doesNotMatch(title(), /queued or running/);
    // A commit still monitored with no run yet: waiting, no deadline, with
    // its last successful check; never Check CI on its own.
    ci({ a: { running: 0, discovering: 0, check: 0, waitingForRun: 1, waitingCheckedAt: "2026-10-19T19:30:00Z" } });
    await waitFor(() => /waiting for its first run, still monitored \(last checked /.test(title()), "waiting for run");
    assert.equal(p.label("a"), "Waiting · CI");
    assert.doesNotMatch(title(), /needs checking|discovery/);
    ci({ a: { running: 0, discovering: 0, check: 1 } });
    await waitFor(() => p.label("a") === "Check CI", "an overdue or failing commit watch is a check");
    ci({});
    await waitFor(() => p.label("a") === "Ready", "terminal cleared");
    assert.deepEqual(p.errors, []);
    assert.ok(
      p.calls.every(
        (c) =>
          ["/api/ci/live", "/api/jobs/live"].includes(c.url) &&
          c.method === "GET",
      ),
    );
  } finally {
    p.close();
  }
});

test("CI errors discard healthy waiting; late and cross-workspace replies cannot overwrite", async () => {
  const p = mount();
  try {
    p.window.refreshLiveCI("w1");
    p.replies.shift()({
      agents: { a: { running: 1, discovering: 0, check: 0 } },
    });
    await waitFor(() => p.label("a") === "Waiting · CI", "waiting");
    const before = { ...p.window.renders };
    p.window.refreshLiveCI("w1");
    p.replies.shift()({
      agents: { a: { running: 1, discovering: 0, check: 0 } },
    });
    await tick();
    assert.deepEqual(
      { ...p.window.renders },
      before,
      "unchanged counts cause no row repaint",
    );
    p.window.refreshLiveCI("w1");
    p.replies.shift()(new Error("Core offline"));
    await waitFor(
      () => p.label("a") === "Check CI",
      "failure not stale waiting",
    );
    p.window.refreshLiveCI("w1");
    p.window.refreshLiveCI("w1");
    const [old, newer] = p.replies.splice(0);
    newer({ agents: {} });
    await tick();
    old({ agents: { a: { running: 5, discovering: 0, check: 0 } } });
    await waitFor(() => p.label("a") === "Ready", "newer wins");
    p.window.refreshLiveCI("w1");
    p.window.refreshLiveCI("w2");
    const [first, second] = p.replies.splice(0);
    first({ agents: { a: { running: 3, discovering: 0, check: 0 } } });
    await tick();
    assert.equal(p.label("a"), "Ready");
    second({ agents: { c: { running: 1, discovering: 0, check: 0 } } });
    await waitFor(() => p.label("c") === "Waiting · CI", "workspace2");
    p.window.refreshLiveCI("w2");
    p.replies.shift()({
      agents: { c: { running: -1, discovering: 0, check: 0 } },
    });
    await waitFor(() => p.label("c") === "Check CI", "bad data fails honestly");
    p.window.clearLiveCI();
    await waitFor(() => p.label("c") === "Ready", "cleanup");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
