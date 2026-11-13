import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { closeTip, openTip, readTip, tipLines } from "./tip-dom.mjs";

// YN-51: an Agent row's ring holds an icon for what it waits on (review >
// CI > Job > sub-agent > shell, the user's order), its card says which one,
// and the row says it to a screen reader. YN-92 (the user chose A on Home,
// design/yn92-ring-waiting): only a running Turn turns the ring; an Agent at
// rest that waits only on what it left running has the grey idle ring, the
// icon in it, and a pill. Rows and their stores in an in-memory bundle,
// Core's reads answered here: no live Core, browser or web/dist.
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
import {stayText, stayTone} from ${JSON.stringify(path.join(root, "src/AgentIsland.tsx"))};
import {refreshLiveJobs} from ${JSON.stringify(path.join(root, "src/live-jobs.ts"))};
import {refreshLiveCI} from ${JSON.stringify(path.join(root, "src/live-ci.ts"))};
import {refreshLiveWaits} from ${JSON.stringify(path.join(root, "src/live-waits.ts"))};
const root = createRoot(document.getElementById('root'));
const select = () => {};
window.renderRows = rows => root.render(<>{rows.map(r => <AgentRailRow key={r.agent.id} {...r} onSelect={select} selected={false}/>)}</>);
window.refreshAll = id => { refreshLiveJobs(id); refreshLiveCI(id); refreshLiveWaits(id); };
window.stayText = stayText;
window.stayTone = stayTone;`,
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
  "/jobs/live": { agents: { job: { active: 1, unknown: 0, name: "web-tests" }, asks: { active: 1, unknown: 0, name: "web-tests" },
    check: { active: 1, unknown: 1 } } },
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
    // The island's state and pill (YN-92), and whether anything in its ring turns.
    island: (id) => { const i = row(id)?.querySelector(":scope > .agent-island"); return i ? [i.dataset.state, i.dataset.stay ?? null] : null; },
    pill: (id) => row(id)?.querySelector(":scope > .agent-island .island-pill")?.textContent ?? null,
    spins: (id) => row(id)?.querySelectorAll(".r-spin").length ?? 0,
    wait: (id) => row(id)?.querySelector(".island-ringbox")?.getAttribute("data-wait") ?? null,
    icons: (id) => row(id)?.querySelectorAll(".island-ringbox .island-wait").length ?? 0,
    said: (id) => row(id)?.querySelector(".agent-select")?.getAttribute("aria-description") ?? "",
    card: (id) => readTip(dom.window, row(id).querySelector(".agent-select")),
    /** Its card's lines, and how many wait lines (with their icon) it has. */
    cardDom: async (id) => {
      const focusable = row(id).querySelector(".agent-select");
      const tip = await openTip(dom.window, focusable);
      const read = { lines: tipLines(tip), waits: tip.querySelectorAll(".agent-card-wait").length };
      await closeTip(dom.window, focusable);
      return read;
    },
    close: () => dom.window.close(),
  };
}
const rows = () => [
  { agent: agent("lead", { kind: "lead" }), statusLabel: "Ready", idle: true },
  { agent: agent("job"), statusLabel: "Ready", idle: true },
  { agent: agent("bg"), statusLabel: "Ready", idle: true },
  { agent: agent("asks", { status: "waiting", pendingCount: 1 }), statusLabel: "Waiting", idle: false },
  { agent: agent("quiet"), statusLabel: "Ready", idle: true },
  { agent: agent("check"), statusLabel: "Ready", idle: true },
];

test("a ring at rest stays still for what its Agent left running: one icon in the grey ring, a pill, and the card says which", async () => {
  const p = mount();
  try {
    p.render(rows());
    p.window.refreshAll("w1");
    await waitFor(() => p.wait("lead") === "review" && p.wait("job") === "job" && p.wait("bg") === "shell" && p.pill("check") != null, "the waits");
    // Its Turn ended (YN-92): the grey ring, still, the icon in it, and a pill that says it.
    for (const [id, wait, pill] of [["lead", "review", "Awaits review"], ["job", "job", "Awaits a Job"], ["bg", "shell", "Awaits a shell"]]) {
      assert.deepEqual(p.island(id), ["idle", "waits"], id);
      assert.equal(p.ring(id), "idle", `${id}: the grey ring`);
      assert.equal(p.spins(id), 0, `${id}: nothing turns`);
      assert.equal(p.wait(id), wait);
      assert.equal(p.icons(id), 1, `${id}: one icon, never two`);
      assert.equal(p.pill(id), pill);
    }
    // The lead waits on its review and on CI: the review shows, CI is named
    // in the card. The card's state line is the wait in full, said once.
    const lead = await p.cardDom("lead");
    assert.equal(lead.lines[1], "Waiting on a review: PR #231, round 2", lead.lines.join(" | "));
    assert.ok(lead.lines.includes("Also: CI"), lead.lines.join(" | "));
    assert.ok(lead.lines.includes("Its Turn has ended: not working, only waiting for what it started"), lead.lines.join(" | "));
    assert.equal(lead.waits, 0, "no wait line of its own: the state's line says it");
    assert.doesNotMatch(lead.lines.join(" | "), /Working/);
    // The row's text starts with the wait, and never says it works.
    assert.match(p.said("lead"), /^Lead · Waiting on a review: PR #231, round 2/);
    assert.doesNotMatch(p.said("lead"), /Working/);
    // One Job, named; background shells, counted.
    assert.equal((await p.card("job"))[1], "Waiting on a Job: web-tests");
    assert.match(p.said("job"), /^Waiting on a Job: web-tests/);
    assert.equal((await p.card("bg"))[1], "Waiting on 2 background shells");
    assert.match(p.said("bg"), /^Waiting on 2 background shells/);
    // Only a Job whose outcome is unknown: at rest, the list's words in its pill, no icon.
    assert.deepEqual(p.island("check"), ["idle", "check"]);
    assert.deepEqual([p.ring("check"), p.spins("check"), p.icons("check"), p.pill("check")], ["idle", 0, 0, "Check job"]);
    assert.ok((await p.card("check")).includes("Its Turn has ended and nothing runs; a Job or CI outcome is unknown and needs checking"));
    assert.match(p.said("check"), /^Check job/);
    // Needs you comes first: no icon, though its Job and CI run. Nothing running: none.
    assert.equal(p.ring("asks"), "waiting");
    assert.equal(p.icons("asks"), 0);
    assert.equal(p.ring("quiet"), "idle");
    assert.equal(p.icons("quiet"), 0);
    assert.equal(p.pill("quiet"), null);
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
    // A running Turn turns its ring (YN-92: only it does), the call's icon in it.
    assert.deepEqual([p.island("w"), p.spins("w"), p.pill("w")], [["working", null], 1, null]);
    const card = await p.cardDom("w");
    assert.ok(card.lines.includes("Waiting on a shell command: cargo test -p core"), card.lines.join(" | "));
    assert.ok(card.lines.includes("Working"), card.lines.join(" | "));
    assert.equal(card.waits, 1, "its wait line, with its icon");
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
    await waitFor(() => p.wait("lead") === "review" && p.pill("check") != null, "the review");
    assert.deepEqual(["lead", "job", "bg", "check"].map(p.pill), ["在等审查", "在等 Job", "在等 shell", "核对 Job"]);
    const lead = await p.card("lead");
    assert.equal(lead[1], "在等审查：PR #231 第 2 轮", lead.join(" | "));
    assert.ok(lead.includes("另有：CI"), lead.join(" | "));
    assert.ok(lead.includes("这一轮已经结束：没在干活，只在等它启动的事跑完"), lead.join(" | "));
    assert.doesNotMatch(lead.join(" | "), /在做/);
    assert.match(p.said("lead"), /^负责人 · 在等审查：PR #231 第 2 轮/);
    assert.doesNotMatch(p.said("lead"), /在做/);
    assert.equal((await p.card("job"))[1], "在等 Job：web-tests");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("each pill of a Turn ended has its words in both languages, and its colour (YN-92)", () => {
  const p = mount();
  try {
    const rows = [
      // [stay, zh, en, tone]
      [{ kind: "waits", on: "review" }, "在等审查", "Awaits review", "working"],
      [{ kind: "waits", on: "ci" }, "在等 CI", "Awaits CI", "working"],
      [{ kind: "waits", on: "job" }, "在等 Job", "Awaits a Job", "working"],
      [{ kind: "waits", on: "subAgent" }, "在等子代理", "Awaits sub-agent", "working"],
      [{ kind: "waits", on: "shell" }, "在等 shell", "Awaits a shell", "working"],
      // A check's words are the list's own, as it gives them.
      [{ kind: "check", label: "Check job / CI" }, "Check job / CI", "Check job / CI", "info"],
      [{ kind: "blocked" }, "受阻", "Blocked", "info"],
      [{ kind: "resultIn" }, "已交结果", "Result in", "info"],
      [{ kind: "between" }, "等下一轮", "Between turns", "quiet"],
    ];
    for (const [stay, zh, en, tone] of rows) {
      assert.equal(p.window.stayText(stay, "zh-Hans"), zh);
      assert.equal(p.window.stayText(stay, "en"), en);
      assert.equal(p.window.stayTone(stay), tone, JSON.stringify(stay));
    }
  } finally {
    p.close();
  }
});
