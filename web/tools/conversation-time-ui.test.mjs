import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// Conversation times and the finished-turn footer, rendered by the real Turn
// component. Fixed time zone; no Core, browser or web/dist writes.
process.env.TZ = "Asia/Shanghai";
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "conversation-time-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {Turn} from ${JSON.stringify(path.join(root, "src/components.tsx"))};
import {conversationTimeMarks} from ${JSON.stringify(path.join(root, "src/conversation-time.ts"))};
const root=createRoot(document.getElementById('root'));
window.renderTurns=({turns,agent,shells,latest})=>{
  const marks=conversationTimeMarks(turns);
  flushSync(()=>root.render(<>{turns.map((turn,i)=><Turn key={turn.id} turn={turn} index={i} agent={agent}
    onFile={()=>{}} onRewindDraft={()=>{}} isLatestAgentTurn={turn.id===latest} timeMarks={marks} backgroundShells={shells}/>)}</>));
};`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "ConversationTimeUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const agent = {
  id: "a", name: "Mori", harness: "codex", color: "green", status: "idle", cwd: "/work", goal: "", model: "",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0,
};
/** Local wall time in Asia/Shanghai (UTC+8), as Unix ms. */
const at = (day, hour, minute, second = 0) => Date.UTC(2026, 9, day, hour - 8, minute, second);
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const label = (ms) => clock.format(new Date(ms));
const timed = (ms, source = "codex") => ({ _yuzunoTime: { at: ms, source } });
const user = (id, text, time) => ({ id, type: "userMessage", content: [{ type: "text", text }], ...(time ? timed(time) : {}) });
const reply = (id, text, time, phase) => ({ id, type: "agentMessage", text, ...(phase ? { phase } : {}), ...(time ? timed(time) : {}) });
const shell = (id) => ({ id, type: "commandExecution", command: "npm test", status: "completed" });

function mount() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} disconnect() {} };
  window.eval(bundle);
  const document = window.document;
  const render = (turns, { shells, latest = turns.at(-1)?.id } = {}) =>
    window.renderTurns({ turns: JSON.parse(JSON.stringify(turns)), agent, shells, latest });
  /** Item id → visible minute label, for every message that shows one. */
  const marks = () =>
    Object.fromEntries([...document.querySelectorAll("[data-item-id]")]
      .filter((node) => node.querySelector(":scope > .message-time, :scope > .message-label > .message-time"))
      .map((node) => [node.dataset.itemId, node.querySelector(".message-time").textContent]));
  const footers = () =>
    [...document.querySelectorAll(".turn-footer")].map((node) => ({
      text: node.textContent.replace(/\s+/g, " ").trim(),
      turn: node.closest("article").dataset.turnId,
      item: node.closest("[data-item-id]")?.dataset.itemId ?? null,
      withCopy: !!node.closest(".reply-actions")?.querySelector(".copy-button"),
    }));
  return { window, document, errors, render, marks, footers, close: () => window.close() };
}

test("one time per natural minute; a new minute or the same clock time on another day shows again", (t) => {
  const page = mount();
  t.after(page.close);
  page.render([
    { id: "t1", status: "completed", items: [
      user("u1", "Check the build", at(13, 10, 0, 5)),
      reply("c1", "Looking at the logs.", at(13, 10, 0, 40), "commentary"),
      shell("s1"),
      reply("r1", "The build passes.", at(13, 10, 1, 10)),
    ] },
    { id: "t2", status: "completed", items: [
      user("u2", "And tomorrow?", at(14, 10, 1, 20)),
      reply("r2", "Still passing.", at(14, 10, 1, 50)),
    ] },
  ]);
  assert.deepEqual(page.marks(), {
    u1: label(at(13, 10, 0)),
    r1: label(at(13, 10, 1)),
    u2: label(at(14, 10, 1)),
  });
  const [first, , third] = page.document.querySelectorAll(".message-time");
  assert.equal(first.closest(".message-label")?.textContent.includes("You"), true, "user time sits in the label row");
  assert.notEqual(first.title, third.title, "full date in the tooltip tells the days apart");
  assert.match(third.getAttribute("datetime"), /^2026-10-14T02:01:20/);
  assert.equal(page.document.querySelectorAll(".tool-activity .message-time").length, 0, "tools carry no times");
});

test("history degrades honestly: only a turn's first input uses the native turn start", (t) => {
  const page = mount();
  t.after(page.close);
  page.render([
    { id: "old", status: "completed", startedAt: at(12, 9, 30) / 1000, items: [
      user("ou", "Old request"),
      reply("or", "Old reply without a time"),
      user("steer", "Untimed follow-up"),
    ] },
    { id: "unknown", status: "completed", items: [user("nu", "No evidence at all"), reply("nr", "Reply")] },
    { id: "live", status: "completed", items: [user("lu", "Same minute as history", at(12, 9, 30, 50)), reply("lr", "Later", at(12, 9, 45))] },
  ]);
  assert.deepEqual(page.marks(), { ou: label(at(12, 9, 30)), lr: label(at(12, 9, 45)) },
    "untimed messages show nothing and do not break a run within one minute");
});

test("streaming, appended input and loading earlier turns keep existing marks on the same messages", (t) => {
  const page = mount();
  t.after(page.close);
  const live = { id: "t2", status: "inProgress", items: [
    user("u2", "Fix the footer", at(13, 14, 0, 10)),
    reply("c2", "Reading", at(13, 14, 0, 30), "commentary"),
  ] };
  page.render([live]);
  const before = page.marks();
  assert.deepEqual(before, { u2: label(at(13, 14, 0)) });
  live.items[1].text = "Reading the component and its styles";
  live.items.push(user("steer", "Also check dark mode", at(13, 14, 2, 5)));
  live.items.push(reply("c3", "Checking dark mode", at(13, 14, 2, 30), "commentary"));
  page.render([live]);
  assert.deepEqual(page.marks(), { ...before, steer: label(at(13, 14, 2)) });
  const older = { id: "t1", status: "completed", items: [user("u1", "Earlier", at(13, 13, 40)), reply("r1", "Done", at(13, 13, 41))] };
  page.render([older, live]);
  assert.deepEqual(page.marks(), { u1: label(at(13, 13, 40)), r1: label(at(13, 13, 41)), u2: before.u2, steer: label(at(13, 14, 2)) });
});

test("Copy reply carries elapsed time, completion and running shells on the latest turn only", (t) => {
  const page = mount();
  t.after(page.close);
  const finished = (id, start, extra = {}) => ({ id, status: "completed", startedAt: start / 1000, items: [
    user(`${id}-u`, "Run it", start),
    reply(`${id}-c`, "Starting the server", start + 1000, "commentary"),
    reply(`${id}-r`, "Server is up.", start + 2000),
  ], ...extra });
  const turns = [
    finished("t1", at(13, 14, 0), { completedAt: at(13, 14, 3) / 1000, durationMs: 180_000 }),
    finished("t2", at(13, 14, 21, 14), { completedAt: at(13, 14, 30) / 1000, durationMs: 526_000 }),
  ];
  page.render(turns, { shells: { state: "known", count: 1, checkedAt: at(13, 14, 30) } });
  assert.deepEqual(page.footers(), [
    { text: `Cooked for 3m 00s · done ${label(at(13, 14, 3))}`, turn: "t1", item: "t1-r", withCopy: true },
    { text: `Cooked for 8m 46s · done ${label(at(13, 14, 30))} · 1 shell still running`, turn: "t2", item: "t2-r", withCopy: true },
  ]);
  assert.ok(page.document.querySelector('[data-item-id="t2-c"] .turn-footer') === null, "progress notes have no footer");
  page.render(turns, { shells: { state: "known", count: 2, checkedAt: 1 } });
  assert.match(page.footers()[1].text, /· 2 shells still running$/);
  page.render(turns, { shells: { state: "known", count: 0, checkedAt: 1 } });
  assert.doesNotMatch(page.footers()[1].text, /shell/, "a known zero is not announced");
  page.render(turns, { shells: { state: "unknown", lastCount: 1, checkedAt: at(13, 14, 31) } });
  const unknown = page.document.querySelectorAll(".turn-footer")[1].lastElementChild;
  assert.equal(unknown.textContent, "shell status unknown");
  assert.match(unknown.title, /1 background shell was running/);
  page.render(turns, { shells: { state: "unknown", lastCount: 0, checkedAt: 1 } });
  assert.doesNotMatch(page.footers()[1].text, /shell/);
});

test("interrupted and failed turns are never done, and missing evidence shows nothing instead of a guess", (t) => {
  const page = mount();
  t.after(page.close);
  page.render([
    { id: "stopped", status: "interrupted", _yuzunoStartedAt: at(13, 9, 0), _yuzunoCompletedAt: at(13, 9, 1, 2),
      items: [user("su", "Long task", at(13, 9, 0)), reply("sr", "Partial answer", at(13, 9, 0, 30))] },
    { id: "halted", status: "interrupted", _yuzunoCompletedAt: at(13, 9, 3),
      items: [user("hu", "Stop soon", at(13, 9, 2)), reply("hr", "Stopping", at(13, 9, 2, 30))] },
    { id: "failed", status: "failed", error: { message: "boom" }, _yuzunoCompletedAt: at(13, 9, 5),
      items: [user("fu", "Try again", at(13, 9, 4))] },
    { id: "claude", status: "completed", _yuzunoDurationMs: 12_400, _yuzunoStartedAt: at(13, 9, 6), _yuzunoCompletedAt: at(13, 9, 7),
      items: [user("cu", "Quick", at(13, 9, 6)), reply("cr", "Quick answer", at(13, 9, 6, 5))] },
    { id: "bare", status: "completed", startedAt: at(13, 9, 8) / 1000, items: [user("bu", "Old"), reply("br", "Old answer")] },
    { id: "running", status: "inProgress", startedAt: at(13, 9, 9) / 1000, items: [user("ru", "Now", at(13, 9, 9)), reply("rr", "Working on it", at(13, 9, 9, 5))] },
  ], { shells: { state: "known", count: 1, checkedAt: 1 }, latest: "running" });
  assert.deepEqual(page.footers(), [
    { text: `Interrupted after 1m 02s · ${label(at(13, 9, 1))}`, turn: "stopped", item: "sr", withCopy: true },
    { text: `Interrupted at ${label(at(13, 9, 3))}`, turn: "halted", item: "hr", withCopy: true },
    { text: `Failed at ${label(at(13, 9, 5))}`, turn: "failed", item: null, withCopy: false },
    { text: `Cooked for 12s · done ${label(at(13, 9, 7))}`, turn: "claude", item: "cr", withCopy: true },
  ], "no done for interruption or failure, no elapsed time from the page clock, no footer while running");
  assert.ok(!page.document.body.textContent.includes("still running"), "only the latest finished agent turn shows shells");
  assert.ok(page.document.querySelector('[data-item-id="br"] > .reply-actions > .copy-button'), "Copy reply stays in the action row without timing evidence");
  assert.ok(page.document.querySelector('[data-item-id="br"] > .reply-actions > .rewind-open'), "Rewind stays beside Copy reply without timing evidence");
  assert.equal(page.document.querySelector('[data-item-id="br"] .turn-footer'), null, "missing timing evidence still shows no invented time");
  assert.deepEqual(page.errors, []);
});

test("finished turns without a final reply still expose Rewind, including untimed history", (t) => {
  const page = mount();
  t.after(page.close);
  page.render([
    { id: "failed", status: "failed", error: { message: "boom" }, items: [user("fu", "Try again")] },
    { id: "stopped", status: "interrupted", items: [user("su", "Stop"), reply("sc", "Checking", null, "commentary")] },
    { id: "tools", status: "completed", items: [user("tu", "Run"), shell("ts")] },
    { id: "running", status: "inProgress", items: [user("ru", "Working"), shell("rs")] },
  ]);
  for (const id of ["failed", "stopped", "tools"]) {
    const row = page.document.querySelector(`[data-turn-id="${id}"] .turn-footer-standalone`);
    assert.ok(row?.querySelector(".rewind-open"), `${id} has a Rewind action`);
    assert.equal(row.querySelector(".rewind-open").disabled, false);
    assert.equal(row.querySelector(".copy-button"), null, "no copy action without a reply");
    assert.equal(row.querySelector(".turn-footer"), null, "no invented timing");
  }
  assert.equal(page.document.querySelector('[data-turn-id="running"] .rewind-open'), null);
  assert.deepEqual(page.errors, []);
});
