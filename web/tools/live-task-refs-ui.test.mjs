import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// A live task list (T-9) through the real BriefSectionBody: the Agent's
// order and notes, Core's facts in each row at both densities (who is
// responsible at either), a quiet mark on the row Core's latest read changed
// while the others stay as they were, and "out of date" while Home's read
// fails. The body is first accepted by the real brief contract, and a
// task notice is parsed as the event stream parses it. No Core or browser.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "live-task-refs-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {BriefSectionBody} from ${JSON.stringify(path.join(root, "src/home/brief/BriefSectionBody.tsx"))};
import {BriefDensity} from ${JSON.stringify(path.join(root, "src/home/home-density.ts"))};
import {HomeReadContext} from ${JSON.stringify(path.join(root, "src/home/home-read.ts"))};
import {checkBriefSection} from ${JSON.stringify(path.join(root, "src/intelligent-ui/brief-contract.ts"))};
import {parseWorkspaceEvent} from ${JSON.stringify(path.join(root, "src/workspace-events.ts"))};
import {saveLanguagePreferences} from ${JSON.stringify(path.join(root, "src/i18n.ts"))};
const root=createRoot(document.getElementById('root'));
window.chooseLanguage=(language)=>saveLanguagePreferences({language});
window.checkBriefSection=checkBriefSection;
window.parseWorkspaceEvent=parseWorkspaceEvent;
window.renderSection=(section,density,read)=>flushSync(()=>root.render(
  <BriefDensity.Provider value={density}><HomeReadContext.Provider value={read}>
    <BriefSectionBody section={section} projectId="p1"/>
  </HomeReadContext.Provider></BriefDensity.Provider>));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "LiveTaskRefs", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
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
  window.fetch = async () => { throw new Error("nothing is fetched"); };
  window.eval(bundle);
  const rows = () => [...window.document.querySelectorAll(".brief-ref-row")].map((row) => ({
    id: row.querySelector(".brief-ref-row-open small")?.textContent,
    title: row.querySelector(".brief-ref-row-title")?.textContent,
    state: row.querySelector(".brief-ref-state")?.textContent ?? null,
    who: row.querySelector(".brief-ref-row-who")?.textContent ?? null,
    meta: row.querySelector(".brief-ref-row-meta")?.textContent ?? null,
    tone: row.dataset.tone ?? null,
    changed: row.hasAttribute("data-changed"),
    stale: row.hasAttribute("data-stale"),
  }));
  return { window, errors, rows, close: () => window.close() };
}

const body = {
  root: "body",
  elements: {
    body: { type: "BriefBody", props: {}, children: ["tasks"] },
    tasks: { type: "LiveRefs", props: { layout: "list", items: [
      { kind: "task", id: "T-9", note: "Card owner" },
      { kind: "task", id: "T-12", note: "Core reply path" },
      { kind: "task", id: "T-14" },
      { kind: "task", id: "T-999", note: "Gone" },
      { kind: "task", id: "T-15" },
    ] } },
  },
};
const who = (id, name) => ({ kind: "agent", id, name });
const task = (id, title, state, tone, assignee, updatedAt) => ({ kind: "task", id, found: true, title, state, tone, assignee, updatedAt });
const refs = (t12 = "doing") => ({
  "task:T-9": task("T-9", "Generative UI", "doing", "active", who("dev7", "Dev 7"), "2026-10-30T00:10:00Z"),
  "task:T-12": task("T-12", "Ask versions (Core)", t12, "active", who("dev3", "Dev 3"), t12 === "doing" ? "2026-10-30T00:00:00Z" : "2026-10-30T00:30:00Z"),
  "task:T-14": task("T-14", "Section CAS", "blocked", "attention", null, "2026-10-29T22:00:00Z"),
  "task:T-999": { kind: "task", id: "T-999", found: false },
  "task:T-15": { kind: "task", id: "T-15", found: false, unavailable: true },
});
const section = (facts) => ({
  key: "work", kind: "report", title: "Who has what", version: 4, owner: { agentId: "dev7", name: "Dev 7", state: "active" },
  updatedAt: "2026-10-30T00:00:00Z", updatedTurnId: null, body, ask: undefined, attachments: [], refs: facts, seen: null, history: false,
});
const live = { at: "2026-10-30T00:31:00Z", failed: false };

test("the brief contract takes a list with notes, and keeps a note short", (t) => {
  const page = mount();
  t.after(page.close);
  const check = (value) => page.window.checkBriefSection({ op: "put", key: "work", kind: "report", title: "Who has what", body: value });
  const accepted = check(body);
  assert.equal(accepted.body.elements.tasks.props.layout, "list");
  assert.equal(accepted.body.elements.tasks.props.items[1].note, "Core reply path");
  const long = structuredClone(body);
  long.elements.tasks.props.items[0].note = "x".repeat(201);
  assert.throws(() => check(long), "a 201-character note is refused");
  const odd = structuredClone(body);
  odd.elements.tasks.props.layout = "grid";
  assert.throws(() => check(odd), "only chips and list are layouts");
});

test("each row is the Agent's item with Core's facts; who is responsible shows at either density", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderSection(section(refs()), "high", live);
  await tick();
  assert.deepEqual(page.rows().map((r) => [r.id, r.title, r.state, r.who, r.tone]), [
    ["T-9", "Generative UI", "In progress", "Assignee Dev 7", "active"],
    ["T-12", "Ask versions (Core)", "In progress", "Assignee Dev 3", "active"],
    ["T-14", "Section CAS", "Blocked", "No assignee", "attention"],
    ["T-999", "T-999", "not found", null, "missing"],
    ["T-15", "T-15", "couldn't read", null, "missing"],
  ]);
  const [owner, , unowned, gone] = page.rows();
  // The task's own update time, and the Agent's note said as the Agent's.
  assert.match(owner.meta, /^Task updated .+Dev 7's note: Card owner$/);
  assert.match(unowned.meta, /^Task updated /);
  // A missing task has nothing of Core's to show, only the Agent's note.
  assert.equal(gone.meta, "Dev 7's note: Gone");
  // Home's read time, apart from each task's.
  assert.match(page.window.document.querySelector(".brief-ref-list-read")?.textContent ?? "", /^States as Core had them at .+/);
  page.window.renderSection(section(refs()), "low", live);
  await tick();
  assert.ok(page.rows().every((r) => r.meta === null), "low density shows no meta line");
  assert.deepEqual(page.rows().map((r) => r.who), ["Assignee Dev 7", "Assignee Dev 3", "No assignee", null, null], "but says who is responsible");
  // In Chinese the state is the board's own word.
  page.window.chooseLanguage("zh-Hans");
  page.window.renderSection(section(refs()), "high", live);
  await tick();
  assert.deepEqual(page.rows().map((r) => [r.state, r.who]), [["进行中", "负责人 Dev 7"], ["进行中", "负责人 Dev 3"], ["受阻", "无负责人"], ["未找到", null], ["读取失败", null]]);
  assert.match(page.rows()[0].meta, /^任务更新于 .+Dev 7 的说明：Card owner$/);
  assert.deepEqual(page.errors, []);
});

test("the row Core's latest read changed carries a quiet mark until a later read finds it unchanged", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderSection(section(refs()), "high", live);
  await tick();
  const before = [...page.window.document.querySelectorAll(".brief-ref-row")];
  assert.ok(page.rows().every((r) => !r.changed), "nothing is marked on the first read");
  page.window.renderSection(section(refs("review")), "high", { ...live, at: "2026-10-30T00:32:00Z" });
  await tick();
  assert.deepEqual(page.rows().filter((r) => r.changed).map((r) => [r.id, r.state]), [["T-12", "To review"]]);
  assert.equal(page.window.document.querySelector(".brief-ref-row[data-changed] .brief-ref-row-changed")?.textContent, "changed");
  // The rows are the same elements: nothing around the changed one was redrawn from scratch.
  const after = [...page.window.document.querySelectorAll(".brief-ref-row")];
  assert.ok(before.every((row, index) => row === after[index]), "the same row elements");
  // It stays while nothing new is read; no timer takes it away.
  await tick(300);
  assert.deepEqual(page.rows().filter((r) => r.changed).map((r) => r.id), ["T-12"]);
  // A later read with the same facts clears it.
  page.window.renderSection(section(refs("review")), "high", { ...live, at: "2026-10-30T00:33:00Z" });
  await tick();
  assert.ok(page.rows().every((r) => !r.changed), "an unchanged read leaves no mark");
  assert.deepEqual(page.errors, []);
});

test("while Home's read fails, the list says its facts are not current", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderSection(section(refs()), "high", { at: "2026-10-30T00:31:00Z", failed: true });
  await tick();
  const banner = page.window.document.querySelector(".brief-ref-list-stale");
  assert.match(banner?.textContent ?? "", /^Out of date: Home couldn't read Core just now\. These are the states read at .+\.$/);
  assert.ok(page.rows().every((r) => r.stale));
  assert.deepEqual(page.rows().map((r) => r.state).slice(0, 2), ["In progress", "In progress"], "the last facts stay, marked");
  // Outside Home (a preview) there is no read to speak of.
  page.window.renderSection(section(refs()), "high", null);
  await tick();
  assert.equal(page.window.document.querySelector(".brief-ref-list-stale"), null);
  assert.deepEqual(page.errors, []);
});

test("a task notice keeps its mark through the event parser; other notices have none", (t) => {
  const page = mount();
  t.after(page.close);
  // As plain data: the page's objects come from its own realm.
  const parse = (value) => JSON.parse(JSON.stringify(page.window.parseWorkspaceEvent(JSON.stringify(value))));
  assert.deepEqual(parse({ type: "workspace.changed", scope: "collaboration", collaboration: true, tasks: true }),
    { type: "workspace.changed", scope: "collaboration", tasks: true });
  assert.deepEqual(parse({ type: "workspace.changed", scope: "collaboration", collaboration: true, tasks: false }),
    { type: "workspace.changed", scope: "collaboration" });
  assert.deepEqual(parse({ type: "workspace.changed", scope: "collaboration", collaboration: true }),
    { type: "workspace.changed", scope: "collaboration" });
});
