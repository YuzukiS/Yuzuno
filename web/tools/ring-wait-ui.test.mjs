import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { readTip } from "./tip-dom.mjs";

// YN-51: an Agent row's turning ring holds an icon for what it waits on
// (review > CI > Job > sub-agent > shell, the user's order), its card says
// which one, and the row says it to a screen reader. Rows and their stores
// in an in-memory bundle, Core's reads answered here: no live Core, browser
// or web/dist.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "ring-wait-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgentRailRow} from ${JSON.stringify(path.join(root, "src/AgentRailRow.tsx"))};
import {refreshLiveJobs} from ${JSON.stringify(path.join(root, "src/live-jobs.ts"))};
import {refreshLiveCI} from ${JSON.stringify(path.join(root, "src/live-ci.ts"))};
import {refreshLiveWaits} from ${JSON.stringify(path.join(root, "src/live-waits.ts"))};
const root = createRoot(document.getElementById('root'));
const select = () => {};
window.renderRows = rows => root.render(<>{rows.map(r => <AgentRailRow key={r.agent.id} {...r} onSelect={select} selected={false}/>)}</>);
window.refreshAll = id => { refreshLiveJobs(id); refreshLiveCI(id); refreshLiveWaits(id); };`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "RingWaitUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
async function waitFor(read, what, tries = 80) {
  for (let i = 0; i < tries; i++) {
    if (read()) return;
    await tick();
  }
  assert.fail(`Timed out waiting for ${what}`);
}

const ended = { seq: 9, outcome: "finished", at: "2026-11-09T08:00:00Z" };
const agent = (id, extra = {}) => ({
  id, name: id, cwd: "/workspace", model: "test", color: "sage", status: "idle", createdAt: "now", updatedAt: "now",
  unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, lastTurnEnd: ended, ...extra,
});
/** Core's three live reads, as this test answers them. */
const reads = {
  "/jobs/live": { agents: { job: { active: 1, unknown: 0, name: "web-tests" }, asks: { active: 1, unknown: 0, name: "web-tests" } } },
  "/ci/live": { agents: { lead: { running: 1, discovering: 0, check: 0 }, asks: { running: 1, discovering: 0, check: 0 } } },
  "/waits/live": { agents: { lead: { reviews: { running: 1, pr: 231, round: 2 } }, bg: { shells: 2 } } },
};
function mount(storage = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<div id="root"></div>', { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  for (const [key, value] of Object.entries(storage)) dom.window.localStorage.setItem(key, value);
  dom.window.fetch = async (url) => {
    const key = Object.keys(reads).find((k) => String(url).endsWith(k));
    const value = key ? reads[key] : {};
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  dom.window.eval(bundle);
  const doc = dom.window.document;
  const row = (id) => doc.querySelector(`[data-agent-id="${id}"]`);
  return {
    window: dom.window,
    errors,
    render: (rows) => dom.window.renderRows(rows),
    ring: (id) => row(id)?.querySelector(".island-ringbox")?.getAttribute("data-ring"),
    wait: (id) => row(id)?.querySelector(".island-ringbox")?.getAttribute("data-wait") ?? null,
    icons: (id) => row(id)?.querySelectorAll(".island-ringbox .island-wait").length ?? 0,
    said: (id) => row(id)?.querySelector(".agent-select")?.getAttribute("aria-description") ?? "",
    card: (id) => readTip(dom.window, row(id).querySelector(".agent-select")),
    close: () => dom.window.close(),
  };
}
const rows = () => [
  { agent: agent("lead", { kind: "lead" }), statusLabel: "Ready", idle: true },
  { agent: agent("job"), statusLabel: "Ready", idle: true },
  { agent: agent("bg"), statusLabel: "Ready", idle: true },
  { agent: agent("asks", { status: "waiting", pendingCount: 1 }), statusLabel: "Waiting", idle: false },
  { agent: agent("quiet"), statusLabel: "Ready", idle: true },
];

test("a ring at rest turns for what its Agent left running, holds one icon, and the card says which", async () => {
  const p = mount();
  try {
    p.render(rows());
    p.window.refreshAll("w1");
    await waitFor(() => p.wait("lead") === "review" && p.wait("job") === "job" && p.wait("bg") === "shell", "the waits");
    // The lead waits on its review and on CI: the review shows, CI is named in the card.
    assert.equal(p.ring("lead"), "working");
    assert.equal(p.icons("lead"), 1, "one icon, never two");
    const lead = await p.card("lead");
    assert.ok(lead.includes("Waiting on a review: PR #231, round 2"), lead.join(" | "));
    assert.ok(lead.includes("Also: CI"), lead.join(" | "));
    assert.match(p.said("lead"), /Waiting on a review/);
    // One Job, named; background shells, counted.
    assert.ok((await p.card("job")).includes("Waiting on a Job: web-tests"));
    assert.ok((await p.card("bg")).includes("Waiting on 2 background shells"));
    // Needs you comes first: no icon, though its Job and CI run. Nothing running: none.
    assert.equal(p.ring("asks"), "waiting");
    assert.equal(p.icons("asks"), 0);
    assert.equal(p.ring("quiet"), "idle");
    assert.equal(p.icons("quiet"), 0);
    assert.doesNotMatch(p.said("quiet"), /Waiting on/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("a running Turn's call shows after a second and goes when it ends; thinking shows none", async () => {
  const p = mount();
  try {
    const working = (turnWait) => [{ agent: agent("w", { status: "working", turnWait }), statusLabel: "Working", idle: false }];
    const shell = { kind: "shell", itemId: "c1", label: "cargo test -p core" };
    p.render(working(shell));
    p.window.refreshAll("w1");
    await tick();
    assert.equal(p.ring("w"), "working");
    assert.equal(p.wait("w"), null, "a call under a second is no wait yet");
    await waitFor(() => p.wait("w") === "shell", "the shell after a second", 80);
    assert.ok((await p.card("w")).includes("Waiting on a shell command: cargo test -p core"));
    // Another call starts its own second; the end of one clears it at once.
    p.render(working({ kind: "subAgent", itemId: "a1", label: "Survey the notes" }));
    await tick();
    assert.equal(p.wait("w"), null);
    await waitFor(() => p.wait("w") === "subAgent", "the sub-agent after a second", 80);
    p.render(working(null));
    await tick();
    assert.equal(p.wait("w"), null, "thinking again: no icon");
    assert.equal(p.icons("w"), 0);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("in Chinese the card and the row say it too", async () => {
  const p = mount({ "yuzuno.language": JSON.stringify({ language: "zh-Hans" }) });
  try {
    p.render(rows());
    p.window.refreshAll("w1");
    await waitFor(() => p.wait("lead") === "review", "the review");
    const lead = await p.card("lead");
    assert.ok(lead.includes("在等审查：PR #231 第 2 轮"), lead.join(" | "));
    assert.ok(lead.includes("另有：CI"), lead.join(" | "));
    assert.match(p.said("lead"), /在等审查/);
    assert.ok((await p.card("job")).includes("在等 Job：web-tests"));
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
