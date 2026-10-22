import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// The Agent list's unfinished-job label and its workspace-wide store, in an
// in-memory bundle: no live Core, browser or web/dist.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "live-jobs-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgentRailRow} from ${JSON.stringify(path.join(root, "src/AgentRailRow.tsx"))};
import {refreshLiveJobs, useAgentJobs} from ${JSON.stringify(path.join(root, "src/live-jobs.ts"))};
const root = createRoot(document.getElementById('root'));
// A probe on the same per-Agent subscription the row uses counts the renders
// a store update causes for that Agent.
window.renders = {};
function Probe({ id }) { useAgentJobs(id); window.renders[id] = (window.renders[id] || 0) + 1; return null; }
const select = () => {};
window.renderRows = rows => root.render(<>{rows.map(r => <React.Fragment key={r.agent.id}><AgentRailRow {...r} onSelect={select} selected={false}/><Probe id={r.agent.id}/></React.Fragment>)}</>);
window.refreshLiveJobs = refreshLiveJobs;`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: {
      write: false,
      lib: { entry, name: "LiveJobsUI", formats: ["iife"] },
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
    { agent: { ...agent("b"), status: "waiting" }, statusLabel: "Waiting", idle: false },
    { agent: agent("c"), statusLabel: "Ready", idle: true },
  ];
  dom.window.renderRows(rows);
  const label = (id) =>
    dom.window.document.querySelector(`[data-agent-id="${id}"] .agent-runtime`)
      ?.textContent;
  return { window: dom.window, calls, errors, replies, rows, label, close: () => dom.window.close() };
}

test("labels follow each Agent's own unfinished jobs and keep other states first", async () => {
  const p = mount();
  try {
    p.window.refreshLiveJobs("w1");
    p.replies.shift()({ agents: { a: { active: 2, unknown: 0 }, b: { active: 1, unknown: 0 } } });
    await waitFor(() => p.label("a") === "Waiting · Job", "a waiting");
    assert.equal(p.label("b"), "Waiting", "waiting for you comes first");
    assert.equal(p.label("c"), "Ready", "another Agent's jobs do not count");
    assert.match(
      p.window.document.querySelector('[data-agent-id="a"] .agent-select').title,
      /2 jobs queued or running/,
    );
    p.window.refreshLiveJobs("w1");
    p.replies.shift()({ agents: { a: { active: 1, unknown: 1 } } });
    await waitFor(() => p.label("a") === "Check job", "unknown only");
    assert.match(
      p.window.document.querySelector('[data-agent-id="a"] .agent-select').title,
      /unknown outcome still holds its reservation/,
    );
    // Running and unknown together: still waiting, and the hint says to check.
    p.window.refreshLiveJobs("w1");
    p.replies.shift()({ agents: { a: { active: 3, unknown: 1 } } });
    await waitFor(() => p.label("a") === "Waiting · Job", "running and unknown");
    const title = p.window.document.querySelector('[data-agent-id="a"] .agent-select').title;
    assert.match(title, /2 jobs queued or running/);
    assert.match(title, /1 job with an unknown outcome still holds its reservation/);
    p.window.refreshLiveJobs("w1");
    p.replies.shift()({ agents: {} });
    await waitFor(() => p.label("a") === "Ready", "cleared");
    assert.ok(p.calls.every((c) => c.url === "/api/jobs/live" && c.method === "GET"));
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a late read never overwrites a newer one; a failed read keeps the last snapshot", async () => {
  const p = mount();
  try {
    p.window.refreshLiveJobs("w1");
    p.window.refreshLiveJobs("w1");
    const [older, newer] = p.replies.splice(0);
    newer({ agents: {} });
    await tick();
    older({ agents: { a: { active: 3, unknown: 0 } } });
    await tick();
    await tick();
    assert.equal(p.label("a"), "Ready");
    p.window.refreshLiveJobs("w1");
    p.replies.shift()({ agents: { c: { active: 1, unknown: 0 } } });
    await waitFor(() => p.label("c") === "Waiting · Job", "c waiting");
    p.window.refreshLiveJobs("w1");
    p.replies.shift()(new Error("Core is restarting"));
    await tick();
    await tick();
    assert.equal(p.label("c"), "Waiting · Job");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("another workspace starts empty, and unchanged counts do not re-render rows", async () => {
  const p = mount();
  try {
    await waitFor(() => p.label("a") === "Ready", "rows mounted");
    p.window.refreshLiveJobs("w1");
    p.replies.shift()({ agents: { a: { active: 1, unknown: 0 } } });
    await waitFor(() => p.label("a") === "Waiting · Job", "a waiting");
    const before = { ...p.window.renders };
    assert.equal(before.a, 2, "a rendered once more when its jobs appeared");
    assert.equal(before.c, 1, "c, with no jobs, did not render again");
    p.window.refreshLiveJobs("w1");
    p.replies.shift()({ agents: { a: { active: 1, unknown: 0 } } });
    await tick();
    await tick();
    assert.deepEqual({ ...p.window.renders }, before, "same counts, no row render");
    // Switching workspaces clears at once, before the new answer arrives,
    // and the old workspace's late answer is dropped.
    p.window.refreshLiveJobs("w1");
    p.window.refreshLiveJobs("w2");
    await waitFor(() => p.label("a") === "Ready", "cleared on switch");
    const [oldWorkspace, newWorkspace] = p.replies.splice(0);
    oldWorkspace({ agents: { a: { active: 5, unknown: 0 } } });
    await tick();
    assert.equal(p.label("a"), "Ready");
    newWorkspace({ agents: { c: { active: 1, unknown: 0 } } });
    await waitFor(() => p.label("c") === "Waiting · Job", "w2 job");
    assert.equal(p.label("a"), "Ready");
  } finally {
    p.close();
  }
});
