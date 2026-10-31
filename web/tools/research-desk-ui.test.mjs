import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { benchmark, doseStudy, fixtureFiles } from "./research-fixtures.mjs";

// T-9: a research desk as Home draws it. The real BriefSectionBody in JSDOM,
// with two synthetic desks of different shapes first accepted by the real
// brief contract; Core's research read is a fetch stub that resolves each
// JSON Pointer in the fixtures' files. No Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "research-desk-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {BriefSectionBody} from ${JSON.stringify(path.join(root, "src/home/brief/BriefSectionBody.tsx"))};
import {CardFoldWorkspace} from ${JSON.stringify(path.join(root, "src/home/card-fold.tsx"))};
import {checkBriefSection} from ${JSON.stringify(path.join(root, "src/intelligent-ui/brief-contract.ts"))};
import {BriefDensity} from ${JSON.stringify(path.join(root, "src/home/home-density.ts"))};
import {saveLanguagePreferences} from ${JSON.stringify(path.join(root, "src/i18n.ts"))};
const root=createRoot(document.getElementById('root'));
window.chooseLanguage=(language)=>saveLanguagePreferences({language});
window.checkBriefSection=checkBriefSection;
window.renderSection=(section,projectId,workspaceId='',density='low')=>flushSync(()=>root.render(<BriefDensity.Provider value={density}><CardFoldWorkspace.Provider value={workspaceId}><BriefSectionBody section={section} projectId={projectId}/></CardFoldWorkspace.Provider></BriefDensity.Provider>));
window.unmountSection=()=>flushSync(()=>root.render(null));`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "ResearchDesk", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick();
  }
  assert.fail(`Timed out waiting for ${description}`);
}

const PROJECT = "proj-1";
const SHA = { "results.json": "a".repeat(64), "protocol.md": "b".repeat(64), "paper.tex": "c".repeat(64), "bench.json": "d".repeat(64), "method.md": "e".repeat(64) };
/** A JSON Pointer in a fixture file, as Core resolves it. */
function pointer(document, at) {
  let value = document;
  for (const step of at.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (value === null || typeof value !== "object" || !(step in value)) return undefined;
    value = value[step];
  }
  return value;
}
/** Core's answer for one desk: each number read, each source's snapshot. */
function resolvedOf(put, version, overrides = {}) {
  const desk = put.body.elements.desk.props;
  const values = {};
  const read = (owner, estimate) => {
    for (const field of ["value", "low", "high"]) {
      const number = estimate[field];
      if (!number || typeof number === "number") continue;
      const found = pointer(fixtureFiles[number.from], number.pointer);
      values[`${owner}.${field}`] = typeof found === "number" ? { status: "read", value: found, from: number.from } : { status: found === undefined ? "missing" : "not_number", from: number.from };
    }
  };
  for (const plot of desk.plots)
    for (const row of plot.rows) {
      read(row.id, row.estimate);
      for (const part of row.parts ?? []) read(part.id, part.estimate);
    }
  const sources = {};
  for (const source of desk.sources)
    if (source.snapshot) {
      const sha = SHA[source.snapshot];
      sources[source.id] = { attachment: source.snapshot, takenAt: "2026-10-31T08:00:00Z", size: 100, sha256: sha, available: true, ...(source.sha256 ? { stated: source.sha256 === sha ? "same" : "different" } : {}) };
    }
  return { key: put.key, version, elementId: "desk", values: { ...values, ...overrides }, sources };
}

function mount(respond) {
  const errors = [];
  const requests = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET" });
    const { status = 200, body = {} } = (await respond(String(url))) ?? {};
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  return { window, document: window.document, errors, requests, close: () => window.close() };
}

/** A put as Core returns it: checked by the contract, its live refs read. */
function section(page, put, version, extra = {}) {
  const normalized = page.window.checkBriefSection(put);
  return {
    key: normalized.key, kind: normalized.kind, title: normalized.title, version,
    owner: { agentId: "agent-a", name: "Researcher", state: "active" },
    updatedAt: "2026-10-31T08:00:00Z", updatedTurnId: "turn-1", body: normalized.body,
    attachments: [], refs: {}, seen: null, history: false, ...extra,
  };
}
/** A desk's research read answered per section version. */
function serve(put, overrides = {}) {
  return (url) => {
    const match = url.match(/\/brief\/research\/([^/]+)\/desk\?version=(\d+)$/);
    if (match && decodeURIComponent(match[1]) === put.key) return { body: resolvedOf(put, Number(match[2]), overrides[match[2]]) };
    return { status: 404, body: { error: "not here" } };
  };
}
const radios = (document, label) => [...document.querySelectorAll(`[role="radiogroup"][aria-label="${label}"] [role="radio"]`)];
const checked = (document, label) => radios(document, label).find((radio) => radio.getAttribute("aria-checked") === "true");
const radio = (document, label, text) => radios(document, label).find((item) => item.textContent.includes(text));

test("two desks of different shapes draw through one component, each number saying where it came from", async () => {
  for (const [put, expect] of [
    [doseStudy, { claim: "High dose shortens recovery", rows: "Recovery time vs placebo (v2): rows", value: "−2.04", interval: "[−3.12, −0.96]" }],
    [benchmark, { claim: "The pass speeds up O2 builds", rows: "Runtime change with the pass: rows", value: "−6.1", interval: "[−8.0, −4.2]" }],
  ]) {
    const page = mount(serve(put));
    try {
      page.window.renderSection(section(page, put, 3), PROJECT, "ws-1");
      const desk = await until(() => page.document.querySelector(".research-desk"), "the desk");
      assert.ok(desk.textContent.includes(expect.claim), put.key);
      await until(() => desk.textContent.includes(expect.value), `${put.key}: the snapshot value`);
      assert.ok(desk.textContent.includes(expect.interval), `${put.key}: its interval`);
      assert.ok(radios(page.document, expect.rows).length >= 2, `${put.key}: rows are radios`);
      assert.ok(page.document.querySelector('.research-origin[data-origin="read"]'), "a snapshot number says so");
      assert.ok(page.document.querySelector(".research-origin").textContent.includes("From a fixed snapshot"));
      assert.ok(!desk.textContent.match(/verified|checked by/i), "nothing is called verified");
      // Reads only: the desk's numbers, once per section version, and nothing that runs.
      assert.ok(page.requests.every((request) => request.method === "GET" && /\/brief\/research\//.test(request.url)), JSON.stringify(page.requests));
      assert.deepEqual(page.errors, []);
    } finally {
      page.close();
    }
  }
});

test("selection follows pointer and keys across the desk, and survives a new version and a Workspace", async () => {
  const page = mount(serve(doseStudy, { 4: { "high-v2.value": { status: "read", value: -2.5, from: "results.json" } } }));
  try {
    page.window.renderSection(section(page, doseStudy, 3), PROJECT, "ws-1");
    const label = "Recovery time vs placebo (v2): rows";
    await until(() => checked(page.document, label), "a selected row");
    assert.ok(checked(page.document, label).textContent.includes("High dose"), "the claim's primary row is selected first");
    // Pointer: another row.
    radio(page.document, label, "Low dose").click();
    await until(() => checked(page.document, label)?.textContent.includes("Low dose"), "the low dose row selected");
    // Keys: down moves the selection and the focus with it.
    const low = checked(page.document, label);
    low.focus();
    low.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await until(() => checked(page.document, label)?.textContent.includes("High dose"), "ArrowDown selects the next row");
    assert.equal(page.document.activeElement, checked(page.document, label), "focus follows the selection");
    assert.equal(checked(page.document, label).tabIndex, 0);
    assert.ok(radios(page.document, label).filter((r) => r.tabIndex === 0).length === 1, "one tab stop per group");
    // Difference or each arm on its own.
    radio(page.document, "Show", "Each arm's own mean").click();
    await until(() => page.document.querySelector(".research-caption")?.textContent === "High dose", "the parts of the selected row");
    assert.ok(page.document.querySelector(".research-main").textContent.includes("Placebo"));
    assert.ok(page.document.querySelector(".research-main").textContent.includes("7.36"));
    radio(page.document, "Show", "Δ = arm − placebo").click();
    await until(() => checked(page.document, label), "the difference again");
    // Evidence: the selected row's numbers, definition and source.
    radio(page.document, "Views of this desk", "Evidence & limits").click();
    const main = await until(() => page.document.querySelector(".research-main h4")?.textContent === "High dose" && page.document.querySelector(".research-main"), "the evidence view of the selected row");
    assert.ok(main.textContent.includes("Definition: Recovery"));
    assert.ok(main.textContent.includes("Symptom-free for 72 hours."));
    assert.ok(main.textContent.includes("From a fixed snapshot · results.json"));
    // A new version in the background: same ids, a new number; the view and row stay.
    page.window.renderSection(section(page, doseStudy, 4), PROJECT, "ws-1");
    await until(() => page.document.querySelector(".research-main")?.textContent.includes("−2.50"), "the new version's number");
    assert.ok(checked(page.document, "Views of this desk").textContent.includes("Evidence & limits"));
    assert.equal(page.document.querySelector(".research-main h4").textContent, "High dose");
    // Kept per Workspace: another Workspace at this address starts fresh and keeps its own.
    page.window.renderSection(section(page, doseStudy, 4), PROJECT, "ws-2");
    await until(() => checked(page.document, "Views of this desk")?.textContent.includes("Claim & interval"), "another Workspace's own selection");
    radio(page.document, "Views of this desk", "Next steps").click();
    await until(() => checked(page.document, "Views of this desk")?.textContent.includes("Next steps"), "a choice in the other Workspace");
    page.window.renderSection(section(page, doseStudy, 4), PROJECT, "ws-1");
    await until(() => checked(page.document, "Views of this desk")?.textContent.includes("Evidence & limits"), "this Workspace's selection again");
    const stored = JSON.parse(page.window.localStorage.getItem("yuzuno.research-desk.v1"));
    assert.deepEqual(Object.keys(stored).sort(), ["ws-1:proj-1:dose-study#desk", "ws-2:proj-1:dose-study#desk"]);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("definitions keep every version, show what a change moved, and plans only preview", async () => {
  const page = mount(serve(doseStudy, { 3: { "low-v2.value": { status: "missing", from: "results.json" } } }));
  try {
    page.window.renderSection(section(page, doseStudy, 3, { refs: {} }), PROJECT, "ws-1");
    await until(() => page.document.querySelector('.research-origin[data-origin="missing"]'), "a pointer that finds nothing");
    assert.ok(page.document.querySelector('.research-origin[data-origin="missing"]').textContent.includes("Not in the snapshot"));
    // The v2 plot reads its numbers from the snapshot; the superseded v1 plot shows the Agent's own.
    const plot = (title) => [...page.document.querySelectorAll(".research-plot")].find((item) => item.querySelector("h5")?.textContent === title);
    const origins = (title) => new Set([...plot(title).querySelectorAll(".research-origin")].map((mark) => mark.dataset.origin));
    assert.deepEqual([...origins("Recovery time vs placebo (v2)")].sort(), ["missing", "read"]);
    assert.deepEqual([...origins("Recovery time vs placebo (v1, superseded)")], ["provided"]);
    assert.ok(plot("Recovery time vs placebo (v1, superseded)").textContent.includes("Provided by the Agent"));
    // Sources: what Core knows, what the Agent said, and that nothing was checked again.
    const aside = page.document.querySelector(".research-aside");
    assert.ok(aside.textContent.includes("SHA-256 aaaaaaaaaaaa"));
    assert.ok(aside.textContent.includes("The source file has not been checked again since."));
    assert.ok(aside.textContent.includes("Not the file content the Agent's SHA-256 names"), "the paper's stated hash differs");
    assert.ok(aside.textContent.includes("As described by the Agent"));
    // History: both versions, before and after, the affected claim and an unapplied draft.
    radio(page.document, "Views of this desk", "Definitions").click();
    const history = await until(() => page.document.querySelector(".research-versions") && page.document.querySelector(".research-main"), "the definitions view");
    assert.ok(history.textContent.includes("v2 · Current") && history.textContent.includes("v1 · Earlier"));
    assert.ok(history.textContent.includes("Every version is kept"));
    const compare = history.querySelector(".research-compare");
    assert.ok(compare.textContent.includes("v1 → v2"));
    assert.ok(compare.textContent.includes("−2.60 [−3.80, −1.40]") && compare.textContent.includes("−2.04 [−3.12, −0.96]"), compare.textContent);
    assert.ok(history.textContent.includes("Not applied"));
    // Next steps: a preview, nothing to run.
    radio(page.document, "Views of this desk", "Next steps").click();
    const next = await until(() => page.document.querySelector(".research-banner")?.parentElement, "the plans");
    assert.ok(next.textContent.includes("nothing runs from this card"));
    assert.ok(next.textContent.includes("Would not produce") && next.textContent.includes("Any new trial data"));
    assert.equal(next.querySelectorAll("button:not(.research-link)").length, 0, "no button starts anything");
    assert.ok(page.requests.every((request) => request.method === "GET"));
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("a plan's links show their live state, and the desk speaks Chinese when asked", async () => {
  const page = mount(serve(benchmark));
  try {
    page.window.chooseLanguage("zh-Hans");
    const refs = { "task:T-12": { kind: "task", id: "T-12", found: true, title: "Quiet machine run", state: "doing", status: "doing" } };
    page.window.renderSection(section(page, benchmark, 3, { refs }), PROJECT, "ws-1", "high");
    const desk = await until(() => page.document.querySelector('.research-desk[data-density="high"]'), "a high-density desk");
    await until(() => desk.textContent.includes("取自固定快照"), "the snapshot label in Chinese");
    radio(page.document, "这个研究桌面的视图", "下一步").click();
    const next = await until(() => page.document.querySelector(".research-links"), "the plan's links");
    assert.ok(next.textContent.includes("Quiet machine run"), next.textContent);
    assert.ok(page.document.querySelector(".research-main").textContent.includes("Job 成功不等于结论成立。"));
    assert.ok(page.document.querySelector(".research-banner").textContent.includes("这张卡片不会运行任何东西"));
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});
