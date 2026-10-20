// T-106: the Jobs panel's GPUs (latest sample, what managed jobs hold, new
// jobs or not, sharing) and a GPU job's request and reservation, against
// fixture HTTP only; no Core, no GPU.
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
const fixture = await mkdtemp(path.join(cache, "job-gpu-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {GpuDevices} from ${JSON.stringify(path.join(root, "src/JobBudget.tsx"))};
import {Jobs, ConversationJobs} from ${JSON.stringify(path.join(root, "src/Jobs.tsx"))};
const root = createRoot(document.getElementById('root'));
window.renderGpus = props => root.render(<GpuDevices {...props}/>);
window.renderJobs = props => root.render(<><Jobs {...props}/><ConversationJobs agentId={props.agent.id} revision={props.revision} disabled={props.disabled}/></>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "JobGpuUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const GPU0 = "GPU-00000000-1111-2222-3333-444444444444";
const GPU1 = "GPU-55555555-6666-7777-8888-999999999999";
const pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what = "condition settles") {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await pause(10);
  }
  assert.ok(check(), what);
}
const device = (extra = {}) => ({
  uuid: GPU0, index: 0, name: "NVIDIA GeForce RTX 5090", memoryTotalMiB: 32607, memoryFreeMiB: 16972,
  admission: "open", closedReason: null, sharing: false, headroomMiB: 1024, reservations: [], ...extra,
});
const gpus = (extra = {}) => ({
  devices: [
    device({ reservations: [{ jobId: "job-1", name: "train", memoryMiB: 8192, mode: "exclusive" }] }),
    device({ uuid: GPU1, index: 1, name: "NVIDIA RTX A4000", memoryTotalMiB: 16376, memoryFreeMiB: 16000,
      admission: "closed", closedReason: "a game is running" }),
  ],
  observedAt: "2026-10-17T21:00:05Z",
  problem: null,
  scope: "Admission among this Core's managed jobs by declared GPU memory.",
  ...extra,
});

function dom() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const { window } = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  return { window, errors };
}
function page(window, errors, calls) {
  return {
    window, document: window.document, calls, errors,
    text: () => window.document.body.textContent.replace(/\s+/g, " "),
    button: (label) => [...window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === label),
    field: (label) => [...window.document.querySelectorAll("label")].find((l) => l.textContent.startsWith(label))?.querySelector("input"),
    close: () => window.close(),
  };
}
async function type(p, input, value) {
  const prototype = p.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
  input.dispatchEvent(new p.window.Event("input", { bubbles: true }));
  await pause();
}

function mountGpus(props) {
  const { window, errors } = dom();
  const calls = [];
  const answers = [];
  window.fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body && JSON.parse(init.body) });
    const [status, body] = answers.shift() ?? [200, gpus()];
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  let saved = 0;
  window.renderGpus({ gpus: gpus(), onSaved: () => saved++, ...props });
  return { ...page(window, errors, calls), answers, saved: () => saved };
}

test("each GPU is a bar of its memory and of what managed jobs reserve on it, and says whether it takes new jobs", async () => {
  const p = mountGpus();
  try {
    await until(() => p.document.querySelectorAll(".jobs-gpu").length === 2);
    const [first, second] = p.document.querySelectorAll(".jobs-gpu");
    assert.equal(first.querySelector(".jobs-gpu-name").textContent, "GPU 0 · RTX 5090");
    assert.match(first.querySelector(".jobs-gpu-name").title,
      new RegExp(`^GPU 0 · NVIDIA GeForce RTX 5090\\n${GPU0}\\nSampled .+\\. Admission among this Core's managed jobs by declared GPU memory\\.$`));
    // In use is the whole card (32607 − 16972 MiB); reserved is what train holds.
    assert.equal(first.querySelector(".jobs-gpu-free").textContent, "15.3 GiB in use");
    assert.equal(first.querySelector(".jobs-gpu-total").textContent, "of 31.8 GiB");
    const share = (el, part) => Number.parseFloat(el.querySelector(`.jobs-meter-${part}`).style.width);
    assert.ok(Math.abs(share(first, "used") - (15635 / 32607) * 100) < 0.01);
    assert.ok(Math.abs(share(first, "reserved") - (8192 / 32607) * 100) < 0.01);
    assert.equal(first.querySelector(".jobs-gpu-held").textContent, "8.0 GiB reserved");
    assert.equal(first.querySelector(".jobs-gpu-held").title, "train: 8.0 GiB exclusive");
    assert.equal(second.querySelector(".jobs-gpu-name").textContent, "GPU 1 · RTX A4000");
    assert.equal(first.querySelector(":scope > small"), null);
    assert.equal(first.querySelector("summary").textContent, "Exclusive");
    assert.equal(p.document.querySelector(".jobs-gpu-busy"), null, "without a host reading, how busy is not said");
    assert.ok(second.classList.contains("is-closed"));
    assert.equal(second.querySelector(".jobs-gpu-held"), null, "nothing reserved, nothing said");
    assert.equal(second.querySelector(".jobs-meter-reserved"), null);
    assert.equal(second.querySelector(":scope > small").textContent, "Closed to new jobs (a game is running). Jobs already on it keep it.");
    assert.equal(second.querySelector("summary").textContent, "Closed");
    assert.equal(p.document.querySelector(".jobs-gpus-problem"), null);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test("how busy a GPU is comes from the host reading of the same device, never from another", async () => {
  const reading = (name, utilPct) => ({ name, utilPct, memUsedMiB: 1, memTotalMiB: 2, attribution: "unknown" });
  const p = mountGpus({ busyNow: [reading("NVIDIA GeForce RTX 5090", 41.6), reading("Another card", 5)] });
  try {
    await until(() => p.document.querySelector(".jobs-gpu-busy"));
    const [first, second] = p.document.querySelectorAll(".jobs-gpu");
    assert.equal(first.querySelector(".jobs-gpu-busy").textContent, "42% busy");
    assert.equal(second.querySelector(".jobs-gpu-busy"), null, "a reading under another name is not this GPU");
  } finally { p.close(); }
});

test("a device an Agent closed says so", async () => {
  const p = mountGpus({ gpus: gpus({ devices: [device({ admission: "closed", closedReason: "cleanup", closedBy: "agent" })] }) });
  try {
    await until(() => p.document.querySelector(".jobs-gpu > small"));
    assert.equal(p.document.querySelector(".jobs-gpu > small").textContent,
      "Closed to new jobs by an Agent (cleanup). Jobs already on it keep it.");
  } finally { p.close(); }
});

test("without a current sample the panel says GPU jobs wait and the free memory is unknown", async () => {
  const p = mountGpus({ gpus: gpus({ problem: "the last GPU sample is older than 60 s",
    devices: [device({ memoryFreeMiB: null })] }) });
  try {
    await until(() => p.document.querySelector(".jobs-gpus-problem"));
    assert.equal(p.document.querySelector(".jobs-gpus-problem").textContent,
      "GPU jobs wait: the last GPU sample is older than 60 s. CPU jobs are not held.");
    assert.equal(p.document.querySelector(".jobs-gpu-free").textContent, "unknown in use");
    assert.equal(p.document.querySelector(".jobs-meter-used"), null, "unknown use draws nothing");
  } finally { p.close(); }
  const none = mountGpus({ gpus: gpus({ devices: [], problem: "GPU sampling failed: nvidia-smi not found" }) });
  try {
    await pause();
    assert.equal(none.document.querySelector(".jobs-gpu, .jobs-gpus-problem"), null, "a host without NVIDIA devices shows nothing");
  } finally { none.close(); }
});

test("closing, opening and sharing settings are posted per UUID, and a refusal is shown", async () => {
  const p = mountGpus();
  try {
    await until(() => p.button("Close to new jobs"));
    await type(p, p.field("Reason"), "  rendering a video ");
    p.button("Close to new jobs").click();
    await until(() => p.calls.length === 1 && p.saved() === 1);
    assert.deepEqual(p.calls[0], { url: `/api/jobs/gpus/${GPU0}/admission`, body: { open: false, reason: "rendering a video" } });
    p.button("Open to new jobs").click();
    await until(() => p.calls.length === 2 && p.saved() === 2);
    assert.deepEqual(p.calls[1], { url: `/api/jobs/gpus/${GPU1}/admission`, body: { open: true } });
    const first = p.document.querySelector(".jobs-gpu");
    await type(p, first.querySelector('input[type="number"]'), "2048");
    first.querySelector('input[type="checkbox"]').click();
    await pause();
    [...first.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save").click();
    await until(() => p.calls.length === 3 && p.saved() === 3);
    assert.deepEqual(p.calls[2], { url: `/api/jobs/gpus/${GPU0}/settings`, body: { sharing: true, headroomMiB: 2048 } });
    p.answers.push([400, { error: "GPU not known on this machine" }]);
    p.button("Open to new jobs").click();
    await until(() => p.document.querySelector(".jobs-gpus-error[role=alert]"));
    assert.equal(p.document.querySelector(".jobs-gpus-error[role=alert]").textContent, "GPU not known on this machine");
    assert.equal(p.saved(), 3);
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

const resources = { cpuMillis: 500, memoryMiB: 128, swapMiB: 0 };
const base = { requestId: "r", taskRef: "T-106", agentId: "a", agent: { name: "Mori" }, machine: { name: "WSL" }, resources,
  reservation: { cpuMillis: 600, memoryMiB: 192, swapMiB: 0 }, createdAt: new Date().toISOString(), argv: ["/bin/sh", "-c", "python train.py"],
  cwd: "/workspace", env: {}, cursor: 1, startedAt: null, finishedAt: null, guardGit: true, timeoutSeconds: 3600 };
const waitingGpu = { ...base, id: "job-g", name: "train on GPU", status: "queued", reserved: false,
  reason: "Waiting for a GPU: NVIDIA GeForce RTX 5090 (GPU-00000000) is in use by managed job train",
  gpu: { memoryMiB: 4096, mode: "shared", devices: [GPU0] } };
const runningGpu = { ...base, id: "job-r", name: "warm-up run", status: "succeeded", reserved: false, finishedAt: new Date().toISOString(),
  gpu: { memoryMiB: 8192 },
  gpuReservation: [{ uuid: GPU0, index: 0, name: "NVIDIA GeForce RTX 5090", memoryMiB: 8192, mode: "exclusive" }] };
const finishedGpu = { ...waitingGpu, id: "job-s", name: "shared GPU run", status: "succeeded", reason: null,
  finishedAt: new Date().toISOString(),
  gpuReservation: [{ uuid: GPU0, index: 0, name: "NVIDIA GeForce RTX 5090", memoryMiB: 4096, mode: "shared" }] };
const plain = { ...base, id: "job-c", name: "cpu only", status: "succeeded", reserved: false, finishedAt: new Date().toISOString() };

const budget = { budget: { cpuMillis: 2000, memoryMiB: 2048, swapMiB: 0 }, reserved: resources, activeCount: 1, queuedCount: 1,
  collectorOverhead: { cpuMillis: 100, memoryMiB: 64, swapMiB: 0 }, gpus: gpus(),
  machine: { name: "WSL", memoryAvailableMiB: 2000, suggestedBudget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 }, maximumBudget: { cpuMillis: 24000, memoryMiB: 20053, swapMiB: 4096 } } };
function mountJobs(jobs) {
  const { window, errors } = dom();
  const calls = [];
  let created = null;
  window.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    let value;
    if (url === "/api/jobs/budget") value = budget;
    else if (url === "/api/jobs" && body) {
      created = { ...base, ...body, id: `job-new-${calls.length}`, status: "queued", reserved: false };
      value = created;
    } else if (created && url === `/api/jobs/${created.id}`) value = created;
    else if (url.endsWith("/logs")) value = { text: "", oldestOffset: 0, totalBytes: 0 };
    else if (url.startsWith("/api/jobs/job-")) value = jobs.find((j) => url === `/api/jobs/${j.id}`) ?? jobs[0];
    else value = { jobs, hasMore: false, nextBefore: null };
    return { ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) };
  };
  window.eval(bundle);
  window.renderJobs({ workspaceId: "w", agent: { id: "a", name: "Mori", cwd: "/workspace", status: "working" }, revision: "1", disabled: false });
  return page(window, errors, calls);
}
const card = (p, name) => [...p.document.querySelectorAll(".conversation-job")].find((c) => c.textContent.includes(name));
// The panel row of a job: its name, and any other text that tells it apart.
const jobRow = (p, ...texts) => [...p.document.querySelectorAll(".job-row")].find((r) => texts.every((t) => r.textContent.includes(t)));
// Open a job and wait until the panel shows that job: its own row selected and
// its detail loaded, with "Run again…". The name and a "Run again…" button
// alone are not enough: React applies the click after this returns, and until
// then the detail of an earlier job with the same name can still be on screen,
// with a "Run again…" of its own that goes when the click is applied.
async function open(p, ...texts) {
  // From the conversation, or from the panel's list once the panel is open
  // (after a submission the list reloads).
  const row = () => jobRow(p, ...texts);
  if (p.document.querySelector('[role="dialog"]')) await until(row, `${texts.join(" ")} is listed`);
  (row() ?? card(p, texts[0])).click();
  await until(
    () => row()?.getAttribute("aria-current") === "true" && p.document.querySelector(".job-detail")?.textContent.includes(texts[0]) && p.button("Run again…"),
    `${texts.join(" ")} is open`,
  );
}
async function rerun(p, ...texts) {
  await open(p, ...texts);
  p.button("Run again…").click();
  await until(() => p.button("Submit job"));
}
const detail = (p) => p.document.querySelector(".job-detail")?.textContent.replace(/\s+/g, " ") ?? "";

test("a GPU job shows what it asked for until admitted, then the device it holds by UUID", async () => {
  const p = mountJobs([waitingGpu, runningGpu]);
  try {
    await until(() => card(p, "train on GPU"));
    card(p, "train on GPU").click();
    await until(() => /GPU4096 MiB shared on GPU-0000/.test(detail(p)));
    assert.match(detail(p), new RegExp(`GPU4096 MiB shared on ${GPU0}; not reserved`));
    assert.match(detail(p), /is in use by managed job train/);
    // The panel shows the machine's GPUs with its budget.
    assert.equal(p.document.querySelectorAll(".jobs-budget .jobs-gpu").length, 2);
    card(p, "warm-up run").click();
    await until(() => detail(p).includes(`(${GPU0})`));
    assert.match(detail(p), new RegExp(`GPUGPU 0 · NVIDIA GeForce RTX 5090 \\(${GPU0}\\) · 8192 MiB exclusive`));
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test("running a GPU job again keeps its GPU request; a CPU job's rerun has none; the form can ask for one", async () => {
  const p = mountJobs([finishedGpu, plain]);
  try {
    await until(() => card(p, "shared GPU run"));
    await rerun(p, "shared GPU run");
    assert.equal(p.field("GPU memory").value, "4096");
    assert.equal(p.document.querySelector(".job-form").textContent.includes(`(${GPU0})`), true);
    p.button("Submit job").click();
    await until(() => p.calls.some((c) => c.url === "/api/jobs" && c.body));
    const posts = () => p.calls.filter((c) => c.url === "/api/jobs" && c.body).map((c) => c.body);
    assert.deepEqual(posts()[0].gpu, { devices: [GPU0], memoryMiB: 4096, mode: "shared" });

    await rerun(p, "cpu only");
    assert.equal(p.field("GPU memory").value, "");
    await type(p, p.field("RAM limit"), "256");
    p.button("Submit job").click();
    await until(() => posts().length === 2);
    assert.equal("gpu" in posts()[1], false);

    await rerun(p, "cpu only");
    await type(p, p.field("GPU memory"), "2048");
    await type(p, p.field("RAM limit"), "320");
    p.button("Submit job").click();
    await until(() => posts().length === 3);
    assert.deepEqual(posts()[2].gpu, { memoryMiB: 2048 });
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});

test("after a rerun is submitted, the detail pane never shows the job it was run from", async () => {
  // The race behind the test above, made deterministic. Once the reply to the
  // submission arrives, the new job is selected, but the detail on hand is
  // still the job it was run from (and a reply for that job can land too)
  // until the selection's effects run. Every state of the detail pane is
  // recorded, so a single render of the wrong job is caught.
  const p = mountJobs([plain]);
  try {
    await until(() => card(p, "cpu only"));
    await rerun(p, "cpu only");
    await type(p, p.field("RAM limit"), "256");
    const seen = [];
    const observer = new p.window.MutationObserver(() => {
      const pane = p.document.querySelector(".job-detail");
      if (pane) seen.push(pane.textContent.replace(/\s+/g, " ").slice(0, 60));
    });
    observer.observe(p.document.body, { subtree: true, childList: true, characterData: true });
    p.button("Submit job").click();
    // The new job is queued; the one it was run from had completed.
    await until(() => /cpu onlyQueued/.test(detail(p)), "the new job is shown");
    observer.disconnect();
    assert.ok(seen.length > 0);
    assert.deepEqual(seen.filter((text) => text.includes("Completed")), [], "the job it was run from is never shown");
    assert.deepEqual(p.errors, []);
  } finally { p.close(); }
});
