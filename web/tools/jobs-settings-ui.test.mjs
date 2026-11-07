// T-55 PR 2: Settings → Jobs & resources has the Core host budget (with how
// many Jobs run at once, the disk reserve, Windows ceiling and GPU settings)
// and the remote machines' Jobs settings; the Jobs card is read only and
// opens Settings there. Against a fixture Core in this file only: no Core,
// no machine, no GPU.
import "./jsdom-guard.mjs";
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
const fixture = await mkdtemp(path.join(cache, "jobs-settings-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {JobsBudgetEditor} from ${src("JobsSettings.tsx")};
import {Jobs} from ${src("Jobs.tsx")};
import {SettingsCenter} from ${src("SettingsCenter.tsx")};
import {settingsCatalog, translatedEditors} from ${src("settings-catalog.ts")};
const root = createRoot(document.getElementById('root'));
window.catalog = {settingsCatalog, translatedEditors};
window.renderHost = props => root.render(<JobsBudgetEditor active {...props}/>);
window.renderJobs = props => root.render(<Jobs workspaceId="w" revision="1" disabled={false} agent={{id:'a',name:'Mori',cwd:'/fixture',status:'idle'}} agents={[]} {...props}/>);
// Settings › Machines (YN-8 S3): the Core host's page has its budget.
window.renderSettings = props => root.render(<SettingsCenter attention={false} {...props} renderEditor={(id, visible, open, request) =>
  id === 'machines' && request?.sub === 'local' ? <JobsBudgetEditor active={visible}/> : <div>Existing {id} editor</div>}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "JobsSettingsUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
    await pause(10);
  }
}
const GPU0 = "GPU-00000000-1111-2222-3333-444444444444";
const GPU1 = "GPU-55555555-6666-7777-8888-999999999999";
const GIB = 1073741824;

/** A fixture Core that keeps what is saved and answers as Core does: the
 * budget POST answers the budget only, and the view names maxActive. `old`
 * is a Core before T-55, which says nothing of maxActive. Each POST takes
 * the next refusal queued, if any. */
function fixtureCore({ old = false, activeCount = 1 } = {}) {
  const state = {
    budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 },
    maxActive: null,
    reserveGiB: null,
    windows: null,
    devices: [
      { uuid: GPU0, index: 0, name: "NVIDIA GeForce RTX 5090", memoryTotalMiB: 32607, memoryFreeMiB: 16972,
        admission: "open", closedReason: null, closedBy: null, sharing: false, headroomMiB: 1024,
        reservations: [{ jobId: "job-1", name: "train", memoryMiB: 8192, mode: "exclusive" }] },
      { uuid: GPU1, index: 1, name: "NVIDIA RTX A4000", memoryTotalMiB: 16376, memoryFreeMiB: 16000,
        admission: "closed", closedReason: "a game is running", closedBy: "user", sharing: false, headroomMiB: 1024, reservations: [] },
    ],
    machines: [
      { id: "local", name: "Core host", kind: "local", defaultCwd: "/fixture" },
      { id: "mini", name: "Mac mini", kind: "ssh", target: "mac-mini", codex: "codex", defaultCwd: "/Users/me/projects",
        maxJobs: 3, budget: { cpuMillis: 4000, memoryMiB: 8192 }, limitMode: "limited" },
      { id: "studio", name: "Studio", kind: "ssh", target: "me@studio.local", codex: "codex", defaultCwd: "/Users/me/studio" },
    ],
    refuse: [],
  };
  const view = () => ({
    machine: { name: "WSL", memoryAvailableMiB: 2000, scope: "fixture", logicalCpus: 32, memoryTotalMiB: 40107, swapTotalMiB: 16384,
      hostHeadroomMiB: 2048, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 } },
    collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 },
    budget: state.budget,
    budgetBounds: { minimum: { cpuMillis: 200, memoryMiB: 128, swapMiB: 0 }, maximum: { cpuMillis: 4096000, memoryMiB: 67108864, swapMiB: 67108864 } },
    reserved: { cpuMillis: 600, memoryMiB: 192, swapMiB: 0 },
    activeCount,
    queuedCount: 1,
    ...(old ? {} : { maxActive: state.maxActive ?? 4, maxActiveSet: state.maxActive != null, maxActiveDefault: 4, maxActiveBounds: { minimum: 1, maximum: 16 } }),
    disk: {
      reserveGiB: state.reserveGiB, defaultRule: "10 GiB, or a tenth of a filesystem smaller than 100 GiB", bounds: { minGiB: 1, maxGiB: 1024 },
      observedAt: "2026-10-17T10:21:00Z", scope: "Checked before each new job starts, not a quota.",
      volumes: [{ device: 1, paths: [{ path: "/data", role: "Core data and job records" }], totalBytes: 1500 * GIB, availableBytes: 107 * GIB,
        reserveBytes: 10 * GIB, low: false, error: null }],
    },
    windows: { available: true, maxJobs: state.windows ?? 2, set: state.windows != null, defaultMaxJobs: 2, activeCount: 1, sharesThisBudget: true },
    gpus: { devices: state.devices, observedAt: "2026-10-17T21:00:05Z", problem: null, scope: "Admission among this Core's managed jobs by declared GPU memory." },
  });
  const route = (url, method, body) => {
    if (method !== "GET" && state.refuse.length) {
      const [status, error] = state.refuse.shift();
      return [status, { error }];
    }
    if (url === "/api/jobs/budget") {
      if (method === "GET") return [200, view()];
      state.budget = { cpuMillis: body.cpuMillis, memoryMiB: body.memoryMiB, swapMiB: body.swapMiB };
      if (!old && "maxActive" in body) state.maxActive = body.maxActive;
      return [200, state.budget];
    }
    if (url === "/api/jobs/disk") {
      state.reserveGiB = body.reserveGiB;
      return [200, { reserveGiB: body.reserveGiB }];
    }
    if (url === "/api/jobs/windows") {
      state.windows = body.maxJobs;
      return [200, { maxJobs: body.maxJobs ?? 2, set: body.maxJobs != null, defaultMaxJobs: 2 }];
    }
    const gpu = url.match(/^\/api\/jobs\/gpus\/([^/]+)\/(admission|settings|pause|resume)$/);
    if (gpu) {
      const device = state.devices.find((d) => d.uuid === decodeURIComponent(gpu[1]));
      if (gpu[2] === "admission")
        Object.assign(device, body.open ? { admission: "open", closedReason: null, closedBy: null } : { admission: "closed", closedReason: body.reason ?? null, closedBy: "user" });
      if (gpu[2] === "settings") Object.assign(device, { sharing: body.sharing, headroomMiB: body.headroomMiB });
      return [200, gpu[2] === "pause" || gpu[2] === "resume" ? { jobs: [] } : device];
    }
    if (url === "/api/machines") return [200, { machines: state.machines }];
    const machine = url.match(/^\/api\/machines\/([^/]+)$/);
    if (machine && method === "PUT") {
      const index = state.machines.findIndex((m) => m.id === machine[1]);
      // Core keeps a folder without its trailing slash.
      const saved = { ...state.machines[index], ...body, defaultCwd: body.defaultCwd.replace(/(.)\/+$/, "$1") };
      for (const key of ["maxJobs", "budget", "limitMode"]) if (saved[key] === null) delete saved[key];
      state.machines[index] = saved;
      return [200, saved];
    }
    // The Jobs list and anything else the panel reads: empty.
    return [200, { jobs: [], hasMore: false, nextBefore: null }];
  };
  return { state, route };
}

function mount(core, { language } = {}) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const { window } = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  if (language) window.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const [status, value] = core.route(url, method, body);
    return { ok: status < 400, status, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  window.eval(bundle);
  const doc = window.document;
  return {
    window, doc, calls, errors,
    posts: (url) => calls.filter((c) => c.method !== "GET" && (!url || c.url === url)),
    group: (label) => doc.querySelector(`[aria-label="${label}"]`),
    close: () => window.close(),
  };
}
const button = (scope, label) => [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ");
const now = (group) => group?.querySelector(".jobs-settings-now")?.textContent ?? "";
const status = (group) => group?.querySelector(".jobs-settings-actions [role=status]")?.textContent ?? "";
const alert = (group) => group?.querySelector("[role=alert]")?.textContent ?? "";
/** Types into a field as the user would, then lets the page render it. */
async function type(p, input, value) {
  const prototype = input.tagName === "SELECT" ? p.window.HTMLSelectElement.prototype : p.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
  input.dispatchEvent(new p.window.Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  await pause();
}

// The guarantee of the Jobs panel test of T-160, now in Settings.
test("the Core host budget in Settings takes the whole host, keeps the default apart, includes collectors and retains validation errors", async () => {
  const core = fixtureCore();
  const p = mount(core);
  try {
    p.window.renderHost();
    await until(() => p.doc.querySelector('input[name="cpu"]'), "the budget is read");
    const form = p.group("This host's Job budget");
    assert.match(text(form), /this host has 32 CPU · 40107 MiB RAM · 16384 MiB swap; the budget may use all of it\. Conservative default: 4 CPU/, "the host totals are for reference only");
    assert.match(text(form), /has the RAM it needs free at that moment, keeping 2048 MiB for Core and the desktop\. CPU is a shared quota, not reserved cores/, "admission also needs free host RAM");
    assert.doesNotMatch(text(form), /ceiling/i, "no share of the host is called a ceiling");
    assert.match(text(form), /4\.2 CPU and 8320 MiB/, "collectors are counted in the example");
    assert.match(text(form), /Running jobs keep their original limits/, "saving says running jobs keep their limits");
    // A slider each (YN-8): its track is the whole host, while a typed value may go to Core's bounds.
    const input = (name) => form.querySelector(`input[type="range"][name="${name}"]`);
    const typed = (name) => input(name).closest(".settings-slider").querySelector('input[type="number"]');
    assert.deepEqual(["cpu", "memory", "swap"].map((name) => [input(name).min, input(name).max]), [["0.2", "32"], ["128", "40107"], ["0", "16384"]], "each track is the whole host");
    assert.deepEqual(["cpu", "memory", "swap"].map((name) => typed(name).max), ["4096", "67108864", "67108864"], "a typed value may go to Core bounds, not only the host size");
    assert.deepEqual(["cpu", "memory", "swap"].map((name) => [input(name).getAttribute("aria-label"), typed(name).getAttribute("aria-label")]),
      [["CPU quota", "CPU quota (CPU)"], ["RAM", "RAM (MiB)"], ["Swap", "Swap (MiB)"]], "each slider and its typed value are named");
    await type(p, input("cpu"), "32");
    await type(p, input("memory"), "40107");
    await type(p, input("swap"), "16384");
    await pause();
    for (const name of ["cpu", "memory", "swap"]) assert.equal(input(name).validity.valid, true, `the whole host is a valid ${name} budget`);
    assert.match(text(form), /Unsaved changes/, "an edit is said to be unsaved");
    core.state.refuse.push([400, "Budget must be 200–4096000 mCPU, 128–67108864 MiB RAM and 0–67108864 MiB swap (including collectors)"]);
    button(form, "Save budget").click();
    await until(() => alert(form), "Core refuses the save");
    assert.match(alert(form), /Budget must be 200–4096000 mCPU/, "the refusal is shown as Core said it");
    assert.equal(input("cpu").value, "32", "the typed value stays to try again");
    assert.deepEqual(p.posts("/api/jobs/budget").map((c) => c.body), [{ cpuMillis: 32000, memoryMiB: 40107, swapMiB: 16384 }], "the budget is sent as typed and maxActive is left out");
    button(form, "Save budget").click();
    await until(() => status(form) === "Saved.", "Core takes the second save");
    assert.equal(p.posts("/api/jobs/budget").length, 2, "two saves, the second taken");
    assert.equal(!!alert(form), false, "the refusal goes once a save is taken");
    await until(() => p.calls.filter((c) => c.url === "/api/jobs/budget" && c.method === "GET").length >= 2, "the budget is read again after the save");
    assert.equal(p.calls.some((c) => c.url.endsWith("/cancel") || (c.url === "/api/jobs" && c.method === "POST")), false, "no job is cancelled or submitted");
    assert.deepEqual(p.errors, [], "no page errors");
  } finally { p.close(); }
});

test("Jobs at once shows the number in effect with its default, and the budget save sends it only when changed, null to return to the default, and Core refusal as it came", async () => {
  const core = fixtureCore();
  const p = mount(core);
  try {
    p.window.renderHost();
    await until(() => p.doc.querySelector('input[name="maxActive"]'), "the budget is read");
    const form = p.group("This host's Job budget");
    const slots = () => form.querySelector('input[type="range"][name="maxActive"]');
    assert.equal(slots().getAttribute("aria-label"), "Jobs at once", "the slider is named Jobs at once");
    assert.equal(slots().value, "4", "the field shows the number in effect");
    assert.deepEqual([slots().min, slots().max, slots().step], ["1", "16", "1"], "the field takes the bounds Core gives");
    assert.equal(now(form), "In effect: 4 at once (default).", "the default is said to be the default");
    assert.match(text(form), /1–16; 4 unless you change it/, "the help names the range and the default");
    assert.equal(!!button(form, "Use default (4)"), false, "nothing to return to while the default applies");
    // A budget change alone leaves maxActive out.
    await type(p, form.querySelector('input[name="cpu"]'), "3");
    button(form, "Save budget").click();
    await until(() => status(form) === "Saved.", "Core takes the budget");
    assert.equal("maxActive" in p.posts("/api/jobs/budget")[0].body, false, "an unchanged Jobs at once is not sent");
    assert.deepEqual(p.posts("/api/jobs/budget")[0].body, { cpuMillis: 3000, memoryMiB: 2048, swapMiB: 0 }, "the budget goes as typed");
    // A new number goes with the budget, in the same POST.
    await type(p, slots(), "6");
    await pause();
    assert.equal(!!status(form), false, "an edit after a save is no longer said saved");
    button(form, "Save budget").click();
    await until(() => now(form) === "In effect: 6 at once.", "Core reads back the new number");
    assert.deepEqual(p.posts("/api/jobs/budget")[1].body, { cpuMillis: 3000, memoryMiB: 2048, swapMiB: 0, maxActive: 6 }, "the changed number goes in the budget POST");
    assert.equal(slots().value, "6", "the field follows what Core saved");
    // Back to the default: null.
    await until(() => button(form, "Use default (4)"), "a saved number offers the default");
    button(form, "Use default (4)").click();
    await pause();
    assert.equal(slots().value, "4", "the default shows in the field");
    assert.equal(p.posts("/api/jobs/budget").length, 2, "choosing the default saves nothing by itself");
    button(form, "Save budget").click();
    await until(() => now(form) === "In effect: 4 at once (default).", "Core reads back the default");
    assert.equal(p.posts("/api/jobs/budget")[2].body.maxActive, null, "the default is asked for with null");
    assert.equal(core.state.maxActive, null, "the fixture Core holds no saved number");
    // Core refusal, as it came; what was typed stays.
    const refusal = "maxActive must be 1–16, or null for the default (4)";
    core.state.refuse.push([400, refusal]);
    await type(p, slots(), "12");
    button(form, "Save budget").click();
    await until(() => alert(form), "Core refuses the number");
    assert.equal(alert(form), refusal, "the refusal is shown as Core said it");
    assert.equal(slots().value, "12", "the typed number stays to try again");
    assert.equal(now(form), "In effect: 4 at once (default).", "what is in effect stays as Core last said");
    // Out of range: a typed 17 is kept to the range (YN-8: a slider), and nothing is sent by typing.
    const sent = p.posts().length;
    const typedSlots = slots().closest(".settings-slider").querySelector('input[type="number"]');
    await type(p, typedSlots, "17");
    typedSlots.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await pause();
    assert.equal(slots().value, "16", "17 is kept to the range's 16");
    assert.equal(p.posts().length, sent, "nothing is sent by typing");
    assert.deepEqual(p.errors, [], "no page errors");
  } finally { p.close(); }
  // A Core before T-55: no field, and the budget goes without it.
  const older = fixtureCore({ old: true });
  const q = mount(older);
  try {
    q.window.renderHost();
    await until(() => q.doc.querySelector('input[name="cpu"]'), "the budget is read");
    const form = q.group("This host's Job budget");
    assert.equal(!!form.querySelector('input[name="maxActive"]'), false, "an older Core shows no Jobs at once");
    assert.doesNotMatch(text(form), /Jobs at once/, "nor names it");
    await type(q, form.querySelector('input[name="cpu"]'), "3");
    button(form, "Save budget").click();
    await until(() => status(form) === "Saved.", "the older Core takes the budget");
    assert.equal("maxActive" in q.posts("/api/jobs/budget")[0].body, false, "maxActive is never sent to an older Core");
    assert.deepEqual(q.errors, [], "no page errors");
  } finally { q.close(); }
});

test("the disk reserve, the Windows ceiling and each GPU admission and sharing are saved from Settings through their own routes", async () => {
  const core = fixtureCore();
  const p = mount(core);
  try {
    p.window.renderHost();
    await until(() => p.doc.querySelector('input[name="reserveGiB"]'), "the budget is read");
    // Disk reserve.
    const disk = p.group("Disk reserve");
    const reserve = () => disk.querySelector('input[name="reserveGiB"]');
    assert.deepEqual([reserve().value, reserve().placeholder, reserve().min, reserve().max], ["", "Default", "1", "1024"], "an empty reserve is the default, within Core bounds");
    assert.match(text(disk), /Empty uses the default: 10 GiB, or a tenth of a filesystem smaller than 100 GiB\. Checked before each new job starts, not a quota\./, "the default rule and scope are said as Core gave them");
    assert.equal(now(disk), "In effect: the default.", "the default is in effect");
    assert.equal(!!button(disk, "Use default"), false, "nothing to return to yet");
    await type(p, reserve(), "30");
    button(disk, "Save reserve").click();
    await until(() => now(disk) === "In effect: keep 30 GiB free.", "Core reads back the reserve");
    assert.deepEqual(p.posts("/api/jobs/disk").map((c) => c.body), [{ reserveGiB: 30 }], "the reserve is posted as a number");
    button(disk, "Use default").click();
    await until(() => now(disk) === "In effect: the default.", "Core reads back the default reserve");
    assert.deepEqual(p.posts("/api/jobs/disk")[1].body, { reserveGiB: null }, "the default is asked for with null");
    assert.equal(reserve().value, "", "the field is empty again for the default");
    // Windows ceiling.
    const windows = p.group("Windows jobs");
    const ceiling = () => windows.querySelector('input[type="range"][name="windowsMaxJobs"]');
    assert.deepEqual([ceiling().value, ceiling().min, ceiling().max], ["2", "1", "64"], "the Windows ceiling starts at its default, shown on its slider");
    assert.equal(now(windows), "In effect: 2 at once (default).", "and said to be the default");
    assert.match(text(windows), /only a ceiling: Windows jobs still share this host's CPU and RAM budget/, "the ceiling is said to be no extra budget");
    await type(p, ceiling(), "3");
    button(windows, "Save").click();
    await until(() => now(windows) === "In effect: 3 at once.", "Core reads back the Windows ceiling");
    assert.deepEqual(p.posts("/api/jobs/windows").map((c) => c.body), [{ maxJobs: 3 }], "the ceiling is posted as a number");
    assert.equal(ceiling().value, "3", "the field shows the saved ceiling");
    // GPUs: admission per UUID.
    const gpu0 = p.group("GPU 0 · NVIDIA GeForce RTX 5090");
    const gpu1 = p.group("GPU 1 · NVIDIA RTX A4000");
    assert.equal(now(gpu0), "Open to new jobs, one managed GPU job at a time.", "an open exclusive GPU says so");
    assert.equal(now(gpu1), "Closed to new jobs (a game is running). Jobs already on it keep it.", "a closed GPU says why");
    await type(p, gpu0.querySelector('input[name="reason"]'), "  rendering a video ");
    button(gpu0, "Close to new jobs").click();
    await until(() => now(gpu0) === "Closed to new jobs (rendering a video). Jobs already on it keep it.", "Core reads back the close");
    assert.deepEqual(p.posts(`/api/jobs/gpus/${GPU0}/admission`).map((c) => c.body), [{ open: false, reason: "rendering a video" }], "the close goes to its UUID with the trimmed reason");
    assert.equal(!!button(gpu0, "Open to new jobs"), true, "a closed GPU can be opened again");
    button(gpu1, "Open to new jobs").click();
    await until(() => now(gpu1) === "Open to new jobs, one managed GPU job at a time.", "Core reads back the opening");
    assert.deepEqual(p.posts(`/api/jobs/gpus/${GPU1}/admission`).map((c) => c.body), [{ open: true }], "the opening goes to its own UUID");
    // Sharing, with the memory kept free.
    gpu1.querySelector('input[name="sharing"]').click();
    await type(p, gpu1.querySelector('input[name="headroomMiB"]'), "2048");
    button(gpu1, "Save").click();
    await until(() => now(gpu1) === "Open to new jobs; managed jobs may share it.", "Core reads back the sharing");
    assert.deepEqual(p.posts(`/api/jobs/gpus/${GPU1}/settings`).map((c) => c.body), [{ sharing: true, headroomMiB: 2048 }], "sharing goes to its UUID");
    core.state.refuse.push([400, "GPU not known on this machine"]);
    button(gpu1, "Save").click();
    await until(() => alert(gpu1), "Core refuses a GPU setting");
    assert.equal(alert(gpu1), "GPU not known on this machine", "the refusal is shown under that GPU as it came");
    assert.equal(!!alert(gpu0), false, "the other GPU shows no refusal");
    // Pausing GPU work acts on running jobs: it stays in the Jobs panel.
    const editor = p.doc.querySelector("#settings-jobs-budget");
    assert.equal(!!editor.querySelector(".jobs-gpu-pause"), false, "no GPU pause in Settings");
    assert.equal(!!button(editor, "Pause GPU work") || !!button(editor, "Resume GPU work"), false, "no pause or resume of GPU work in Settings");
    assert.equal(p.posts().some((c) => /\/(pause|resume)$/.test(c.url)), false, "nothing is paused or resumed");
    assert.deepEqual(p.errors, [], "no page errors");
  } finally { p.close(); }
});

test("the Jobs card shows no editor, shows active against maxActive, keeps GPU pause and resume, and Edit in Settings asks for the Core host budget", async () => {
  const core = fixtureCore({ activeCount: 3 });
  const p = mount(core);
  const asked = [];
  try {
    p.window.renderJobs({ onOpenSettings: (editor) => asked.push(editor) });
    await until(() => p.doc.querySelector('[aria-label="Jobs"]'), "the Jobs entry shows");
    p.doc.querySelector('[aria-label="Jobs"]').click();
    await until(() => p.doc.querySelector(".jobs-budget .jobs-gpu"), "the machine card is read");
    const card = p.doc.querySelector(".jobs-budget");
    const counts = card.querySelector(".jobs-budget-counts");
    assert.equal(counts.textContent, "3 of 4 active · 1 queued", "active is shown against how many may run");
    assert.equal(counts.title, "At most 4 of this host's jobs run at once (the default); one more waits in the queue.", "the tip says the number is the default");
    assert.equal(!!card.querySelector("input, select, textarea, details, form"), false, "the card has no editor");
    for (const label of ["Save budget", "Save reserve", "Save", "Close to new jobs", "Open to new jobs", "Use default"])
      assert.equal(!!button(card, label), false, `the card offers no ${label}`);
    assert.deepEqual([...card.querySelectorAll(".jobs-meter-name")].map((el) => el.textContent), ["CPU", "RAM", "Disk", "Windows", "GPU 0 · RTX 5090", "GPU 1 · RTX A4000"], "the status meters stay");
    assert.deepEqual([...card.querySelectorAll(".jobs-gpu-mode")].map((el) => el.textContent), ["Exclusive", "Closed"], "each GPU says how it takes jobs");
    // Pausing GPU work stays: an action on running jobs.
    const pauses = [...card.querySelectorAll(".jobs-gpu-pause")];
    assert.deepEqual(pauses.map((b) => b.textContent.trim()), ["Pause GPU work", "Pause GPU work"], "each GPU keeps its pause");
    pauses[0].click();
    await until(() => p.posts(`/api/jobs/gpus/${GPU0}/pause`).length === 1, "the pause is posted");
    assert.equal(p.posts().length, 1, "only the pause is written");
    const edit = button(card, "Edit in Settings");
    assert.equal(!!edit, true, "the card offers Edit in Settings");
    edit.click();
    await until(() => !p.doc.querySelector('[role="dialog"]'), "the Jobs panel closes");
    assert.deepEqual(asked, ["jobs-budget"], "Settings is asked for at the Core host budget");
    assert.deepEqual(p.errors, [], "no page errors");
  } finally { p.close(); }
  // A Core before T-55: the counts as before.
  const q = mount(fixtureCore({ old: true, activeCount: 3 }));
  try {
    q.window.renderJobs({});
    await until(() => q.doc.querySelector('[aria-label="Jobs"]'), "the Jobs entry shows");
    q.doc.querySelector('[aria-label="Jobs"]').click();
    await until(() => q.doc.querySelector(".jobs-budget-counts"), "the machine card is read");
    assert.equal(q.doc.querySelector(".jobs-budget-counts").textContent, "3 active · 1 queued", "an older Core shows the counts alone");
    assert.equal(!!button(q.doc.querySelector(".jobs-budget"), "Edit in Settings"), false, "without a way to Settings there is no button");
  } finally { q.close(); }
});

// The handoff's focus (T-55): Settings puts it on its editor, so the Jobs
// dialog closed by Edit in Settings gives none back to its trigger; Escape
// and its close button still do, before and after a handoff.
test("a Jobs dialog closed by Edit in Settings gives no focus back to its trigger, while a plain close still does", async () => {
  const core = fixtureCore();
  const p = mount(core);
  const asked = [];
  try {
    p.window.renderJobs({ onOpenSettings: (editor) => asked.push(editor) });
    await until(() => p.doc.querySelector('[aria-label="Jobs"]'), "the Jobs entry shows");
    const trigger = p.doc.querySelector('[aria-label="Jobs"]');
    const dialog = () => p.doc.querySelector('[role="dialog"]');
    const openJobs = async () => {
      trigger.click();
      await until(() => dialog()?.querySelector(".jobs-budget"), "the Jobs dialog shows its machine card");
    };
    // After the dialog has gone, every timer set while it closed has run:
    // the dialog gives focus back in one of them.
    const settled = async () => {
      await until(() => !dialog(), "the Jobs dialog closes");
      for (let n = 0; n < 3; n++) await new Promise((done) => p.window.setTimeout(done, 0));
    };
    const escape = () => dialog().dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    // A plain close: its close button, then Escape.
    await openJobs();
    p.doc.querySelector('[aria-label="Close jobs"]').click();
    await settled();
    assert.equal(p.doc.activeElement === trigger, true, "the close button gives focus back to the Jobs button");
    await openJobs();
    escape();
    await settled();
    assert.equal(p.doc.activeElement === trigger, true, "Escape gives focus back to the Jobs button");
    // The handoff: focus is on Edit in Settings, as a click leaves it.
    await openJobs();
    const edit = button(dialog(), "Edit in Settings");
    edit.focus();
    assert.equal(p.doc.activeElement === edit, true, "Edit in Settings has the focus before the handoff");
    edit.click();
    await settled();
    assert.deepEqual(asked, ["jobs-budget"], "Settings is asked for at the Core host budget");
    assert.equal(p.doc.activeElement === trigger, false, "the handoff gives no focus back to the Jobs button");
    // A later plain close is not taken for a handoff.
    await openJobs();
    escape();
    await settled();
    assert.equal(p.doc.activeElement === trigger, true, "after a handoff, a plain close gives focus back again");
    assert.deepEqual(asked, ["jobs-budget"], "a plain close asks for no Settings");
    assert.equal(p.posts().length, 0, "closing writes nothing");
    assert.deepEqual(p.errors, [], "no page errors");
  } finally { p.close(); }
});

test("Settings opens the Core host's page of Machines at its budget, and an unsaved field survives switching pages", async () => {
  const { settingsCatalog, translatedEditors } = (() => {
    const p = mount(fixtureCore());
    try { return JSON.parse(JSON.stringify(p.window.catalog)); } finally { p.close(); }
  })();
  const entry = (id) => settingsCatalog.find((e) => e.id === id);
  assert.deepEqual(entry("budget").target, { kind: "editor", editor: "jobs-budget" }, "the Core host budget entry opens its editor");
  assert.deepEqual(entry("remote-budget").target, { kind: "editor", editor: "jobs-remote" }, "the remote budgets entry opens Machines");
  assert.equal(settingsCatalog.some((e) => e.target.kind === "jobs"), false, "no entry jumps to the Jobs panel");
  assert.equal(translatedEditors.includes("jobs-budget"), true, "the Core host editor follows the interface language");
  const p = mount(fixtureCore());
  try {
    // The Jobs card's Edit in Settings names the budget editor: the Core host's page (YN-8 S3).
    p.window.renderSettings({ openAt: { editor: "jobs-budget", nonce: 1 } });
    const tab = (id) => p.doc.getElementById(`settings-tab-${id}`);
    const shown = () => [...p.doc.querySelectorAll(".settings-editor")].filter((el) => !el.hidden).map((el) => el.id);
    const field = () => p.doc.querySelector('#settings-editor-machines input[name="maxActive"]');
    await until(field, "the Core host editor reads the budget");
    assert.deepEqual(shown(), ["settings-editor-machines"], "the Machines page");
    assert.equal(tab("machines").getAttribute("aria-selected"), "true");
    assert.equal(p.doc.querySelectorAll(".settings-catalog-card").length, 0, "no card that opens something elsewhere");
    await type(p, field(), "7");
    tab("updates").click();
    await until(() => shown().join() === "settings-editor-updates", "another page");
    tab("machines").click();
    await until(() => shown().includes("settings-editor-machines"), "back at the Machines page");
    assert.equal(field().value, "7", "an unsaved Jobs at once survives switching pages");
    assert.equal(p.posts().length, 0, "browsing writes nothing");
    assert.deepEqual(p.errors, [], "no page errors");
  } finally { p.close(); }
});

test("in Chinese the Core host editor reads in Chinese, with names and Core words as they came", async () => {
  const p = mount(fixtureCore(), { language: "zh-Hans" });
  try {
    p.window.renderHost();
    await until(() => p.doc.querySelector('input[name="maxActive"]'), "the budget is read");
    const section = p.doc.querySelector("#settings-jobs-budget");
    assert.equal(section.querySelector("h3").textContent, "Core 主机预算", "the editor title is Chinese");
    assert.equal(section.getAttribute("lang"), "zh-Hans", "the editor says it is Chinese");
    const form = p.group("此主机的 Job 预算");
    assert.equal(form.querySelector('input[type="range"][name="maxActive"]').getAttribute("aria-label"), "同时运行的 Job 数", "the slider's name is Chinese");
    assert.equal(now(form), "当前生效：同时最多 4 个（默认）。", "what is in effect is said in Chinese");
    assert.match(text(section), /WSL/, "the machine name stays as it came");
    assert.match(text(p.group("磁盘保留")), /10 GiB, or a tenth of a filesystem smaller than 100 GiB/, "Core rule stays as it came");
  } finally { p.close(); }
});
