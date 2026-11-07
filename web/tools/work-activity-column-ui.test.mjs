import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// Work activity without a "Needs a look" group (YN-17 S2, the user's
// decision): what went wrong lists in its own kind's group, with its state,
// and the entry counts what is running. The real column and entry in JSDOM,
// fed through the hook the Jobs, CI and review docks register with, each
// item classified by the same functions those docks use; no Core, browser
// or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "work-activity-column-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(entry, `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {WorkActivityProvider, WorkActivityColumn, WorkActivityEntry, useWorkActivity} from ${JSON.stringify(path.join(root, "src/WorkDock.tsx"))};
import {jobWork, reviewWork, runWork} from ${JSON.stringify(path.join(root, "src/work-activity.ts"))};
const open = () => {};
const jobs = [
  {id: 'j1', kind: 'job', state: jobWork('succeeded'), name: 'docs build', says: 'Succeeded', onOpen: open},
  {id: 'j2', kind: 'job', state: jobWork('running'), name: 'lint', says: 'Running', onOpen: open},
  {id: 'j3', kind: 'job', state: jobWork('failed'), name: 'web build', says: 'Failed', onOpen: open},
];
const runs = [{id: 'c1', kind: 'run', state: runWork('completed', 'failure'), name: 'CI', says: 'failure', onOpen: open}];
const reviews = [
  {id: 'r1', kind: 'review', state: reviewWork('completed', true, 'no_findings'), name: 'PR #42 · round 1', says: 'No actionable findings', onOpen: open},
  {id: 'r2', kind: 'review', state: reviewWork('completed', false, 'changes_requested'), name: 'PR #42 · round 2', says: 'Changes requested', onOpen: open},
];
function Kind({kind, items}) { useWorkActivity(kind, items, open, true); return null; }
const root = createRoot(document.getElementById('root'));
window.render = () => flushSync(() => root.render(<WorkActivityProvider>
  <Kind kind="job" items={jobs}/><Kind kind="run" items={runs}/><Kind kind="review" items={reviews}/>
  <WorkActivityEntry onOpen={open}/>
  <WorkActivityColumn onBack={open}/>
</WorkActivityProvider>));`);
  const result = await build({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "WorkActivityColumn", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(language) {
  const errors = [], vc = new VirtualConsole();
  vc.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  window.eval(bundle);
  window.render();
  // The kinds register from an effect; the provider draws them a render later.
  await tick();
  await tick();
  const document = window.document;
  const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
  const groups = () => [...document.querySelectorAll(".work-activity-column-list section")].map((section) => ({
    label: text(section.querySelector("h3")),
    rows: [...section.querySelectorAll(".work-activity-row:not(.work-activity-row-list)")].map((row) => ({
      name: text(row.querySelector(".work-activity-row-name")),
      says: text(row.querySelector(".work-activity-row-says")),
      state: row.getAttribute("data-state"),
    })),
  }));
  return { document, errors, groups, entry: () => document.querySelector(".work-activity-entry"), text, close: () => window.close() };
}

for (const [language, words] of [
  ["en", { jobs: "Jobs", runs: "CI", reviews: "Reviews", running: "1 running", gone: /need a look|Needs a look/i }],
  ["zh-Hans", { jobs: "Jobs", runs: "CI", reviews: "审查", running: "1 个在进行", gone: /待查看|需要注意/ }],
]) {
  test(`${language}: a failed Job, a red CI run and a changes-requested review stay in their own groups; no "Needs a look" group or count`, async (t) => {
    const page = await mount(language);
    t.after(page.close);
    const groups = page.groups();
    // Each kind once, in its usual order, and no group of what went wrong.
    assert.deepEqual(groups.map((g) => g.label), [words.jobs, words.runs, words.reviews]);
    assert.ok(!groups.some((g) => words.gone.test(g.label)), `no attention group: ${groups.map((g) => g.label).join(", ")}`);
    // What went wrong first within its group, with its state; then what is
    // going on; then what ended well.
    assert.deepEqual(groups[0].rows, [
      { name: "web build", says: "Failed", state: "exception" },
      { name: "lint", says: "Running", state: "current" },
      { name: "docs build", says: "Succeeded", state: "done" },
    ]);
    assert.deepEqual(groups[1].rows, [{ name: "CI", says: "failure", state: "exception" }]);
    assert.deepEqual(groups[2].rows, [
      { name: "PR #42 · round 2", says: "Changes requested", state: "exception" },
      { name: "PR #42 · round 1", says: "No actionable findings", state: "done" },
    ]);
    // The entry counts what is running, and nothing as needing a look.
    const entry = page.entry();
    assert.ok(!!entry, "the entry is there");
    assert.equal(page.text(entry.querySelector(".work-activity-counts")), words.running);
    assert.ok(!words.gone.test(page.text(entry)), `the entry says no "need a look": ${page.text(entry)}`);
    assert.equal(entry.hasAttribute("data-needs-look"), false);
    assert.deepEqual(page.errors, []);
  });
}
