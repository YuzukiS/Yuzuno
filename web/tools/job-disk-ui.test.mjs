// The disk section (T-95) against fixture HTTP only; no Core: what the Jobs
// panel shows, and the reserve, set in Settings (T-55).
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { tipOf } from "./tip-dom.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "job-disk-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {DiskReserveSettings, DiskSpace} from ${JSON.stringify(path.join(root, "src/JobBudget.tsx"))};
const root = createRoot(document.getElementById('root'));
window.render = props => root.render(<DiskSpace {...props}/>);
window.renderReserve = props => root.render(<DiskReserveSettings {...props}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "JobDiskUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const GIB = 1073741824;
const pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what = "condition settles") {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await pause(10);
  }
  assert.ok(check(), what);
}
const disk = (extra = {}) => ({
  reserveGiB: null,
  defaultRule: "10 GiB, or a tenth of a filesystem smaller than 100 GiB",
  bounds: { minGiB: 1, maxGiB: 1024 },
  observedAt: "2026-10-17T10:21:00Z",
  scope: "Checked before each new job starts, not a quota.",
  volumes: [
    { device: 1, paths: [{ path: "/data", role: "Core data and job records" }, { path: "/data/w", role: "working directory" }],
      totalBytes: 1500 * GIB, availableBytes: 107 * GIB, reserveBytes: 10 * GIB, low: false, error: null },
    { device: 2, paths: [{ path: "/scratch", role: "working directory" }],
      totalBytes: 50 * GIB, availableBytes: 3 * GIB, reserveBytes: 5 * GIB, low: true, error: null },
    { device: null, paths: [{ path: "/gone", role: "working directory" }],
      totalBytes: null, availableBytes: null, reserveBytes: null, low: null, error: "No such file or directory (os error 2)" },
  ],
  ...extra,
});

function mount(props, editor = false) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  const answers = [];
  window.fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body && JSON.parse(init.body) });
    const [status, body] = answers.shift() ?? [200, { reserveGiB: null }];
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  let saved = 0;
  (editor ? window.renderReserve : window.render)({ disk: disk(), onSaved: () => saved++, ...props });
  return {
    window, document: window.document, calls, errors, answers, saved: () => saved,
    text: () => window.document.body.textContent.replace(/\s+/g, " "),
    button: (label) => [...window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === label),
    input: () => window.document.querySelector('input[name="reserveGiB"]'),
    close: () => window.close(),
  };
}

test("each filesystem is one bar of what is used, its folders in the tip, a low or unreadable one said in words", async () => {
  const page = mount();
  try {
    await until(() => page.document.querySelectorAll(".jobs-disk-volume").length === 3);
    const rows = [...page.document.querySelectorAll(".jobs-disk-volume")];
    assert.deepEqual(rows.map((r) => r.querySelector(".jobs-disk-paths").textContent), ["Disk 1", "Disk 2", "Disk 3"]);
    assert.equal(rows[0].querySelector(".jobs-disk-free").textContent, "107.0 GiB free");
    assert.equal(rows[0].querySelector(".jobs-disk-total").textContent, "of 1500.0 GiB");
    // Its tip (YN-44): its name, then what it holds and when it was read.
    assert.match((await tipOf(rows[0].querySelector(".jobs-disk-paths"))).slice(1).join("\n"), /^Core data and job records: \/data\nworking directory: \/data\/w\nRead /);
    const used = Number.parseFloat(rows[0].querySelector(".jobs-meter-used").style.width);
    assert.ok(Math.abs(used - (1393 / 1500) * 100) < 0.01, `used share ${used}`);
    assert.equal(rows[0].querySelector(".jobs-meter-reserved"), null, "a disk has nothing reserved");
    assert.equal(rows[0].querySelector(":scope > small"), null);
    assert.ok(rows[1].classList.contains("is-low"));
    assert.equal(rows[1].querySelector(":scope > small").textContent, "Below the 5.0 GiB reserve: new jobs wait here. Running jobs go on.");
    assert.ok(rows[2].classList.contains("is-unknown"));
    assert.equal(rows[2].querySelector(".jobs-disk-free").textContent, "Free space unknown");
    assert.equal(rows[2].querySelector(".jobs-disk-total"), null);
    assert.equal(rows[2].querySelector(".jobs-meter-used"), null, "unknown use draws nothing");
    assert.match(rows[2].querySelector(":scope > small").textContent, /Could not be read \(No such file or directory \(os error 2\)\); new jobs wait until it can be checked\./);
    // The reserve is set in Settings (T-55): the cells only show the disks.
    assert.equal(!!page.document.querySelector(".jobs-disk-volume input, .jobs-disk-volume details, .jobs-disk-volume button"), false, "no disk cell has an editor");
    assert.deepEqual(page.calls, [], "showing the disks sends nothing");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("with no disk reported one cell says so, and the reserve can still be set in Settings", async () => {
  const page = mount({ disk: disk({ volumes: [] }) });
  try {
    await until(() => page.document.querySelectorAll(".jobs-disk-volume").length === 1);
    const cell = page.document.querySelector(".jobs-disk-volume");
    assert.ok(cell.classList.contains("is-unknown"));
    assert.equal(cell.querySelector(".jobs-disk-free").textContent, "Not reported");
    assert.equal(!!cell.querySelector(".jobs-meter-used"), false, "unknown use draws nothing");
    assert.equal(!!cell.querySelector("input, details"), false, "the cell has no editor");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
  const editor = mount({ disk: disk({ volumes: [] }) }, true);
  try {
    await until(() => editor.button("Save reserve"));
    assert.equal(!!editor.document.querySelector('input[name="reserveGiB"]'), true, "the reserve can still be set without a disk reported");
    assert.match(editor.text(), /Empty uses the default: 10 GiB, or a tenth of a filesystem smaller than 100 GiB\. Checked before each new job starts, not a quota\./, "the default rule and scope are said as Core gave them");
    assert.deepEqual(editor.errors, []);
  } finally { editor.close(); }
});

test("the reserve is saved as a number, returns to the default as null, and a refusal is shown", async () => {
  const page = mount({ disk: disk({ reserveGiB: 20 }) }, true);
  try {
    await until(() => page.button("Save reserve"));
    // One reserve for every disk.
    assert.equal(page.document.querySelectorAll('input[name="reserveGiB"]').length, 1, "one reserve for every disk");
    assert.equal(page.document.querySelector(".jobs-settings-now").textContent, "In effect: keep 20 GiB free.", "the saved reserve is said to be in effect");
    const input = page.document.querySelector('input[name="reserveGiB"]');
    assert.equal(input.value, "20");
    assert.equal(input.min, "1");
    assert.equal(input.max, "1024");
    const setter = Object.getOwnPropertyDescriptor(page.window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "30");
    input.dispatchEvent(new page.window.Event("input", { bubbles: true }));
    page.answers.push([200, { reserveGiB: 30 }]);
    page.button("Save reserve").click();
    await until(() => page.calls.length === 1 && page.saved() === 1);
    assert.deepEqual(page.calls[0], { url: "/api/jobs/disk", body: { reserveGiB: 30 } });
    page.answers.push([200, { reserveGiB: null }]);
    page.button("Use default").click();
    await until(() => page.calls.length === 2 && page.saved() === 2);
    assert.deepEqual(page.calls[1].body, { reserveGiB: null });
    page.answers.push([400, { error: "The disk reserve must be 1–1024 GiB" }]);
    page.button("Save reserve").click();
    await until(() => page.document.querySelector(".jobs-settings-disk [role=alert]"));
    assert.equal(page.document.querySelector(".jobs-settings-disk [role=alert]").textContent, "The disk reserve must be 1–1024 GiB");
    assert.equal(page.input().value, "30", "the typed value stays to try again");
    assert.equal(page.saved(), 2);
  } finally { page.close(); }
});
