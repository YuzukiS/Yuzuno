import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// YN-113 R3, in jsdom: a refreshing card's tag and state, its schedule panel
// (each write going to Core's own route with the version read), and a report
// page's past issues read from Core, shown read only. Synthetic sections and
// a stand-in Core; no real Core, browser or web/dist writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "refresh-card-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {SummaryCard} from ${JSON.stringify(path.join(root, "src/home/SummaryCard.tsx"))};
import {RefreshPanel} from ${JSON.stringify(path.join(root, "src/home/RefreshPanel.tsx"))};
import {ReportPage} from ${JSON.stringify(path.join(root, "src/home/report/ReportPage.tsx"))};
let root;
function mount(node){ if(root) root.unmount(); root=createRoot(document.getElementById('host')); root.render(node); }
window.mountCard=(section,readOnly=false)=>mount(<SummaryCard section={section} projectId="p1" workspaceId="ws-1" agents={[]} readOnly={readOnly} onSeen={async()=>{}} />);
window.mountPanel=(section,onChanged,onClose=()=>{})=>mount(<RefreshPanel section={section} projectId="p1" refresh={section.refresh} readOnly={false} onChanged={onChanged} onClose={onClose} />);
window.mountReport=(data,link)=>mount(<ReportPage link={link} back={false} data={data} readFailed={false} workspaceId="ws-1" agents={[]} readOnly={false} onBack={()=>{}} onOpenVersion={()=>{}} onShowProject={()=>{}} onSeen={async()=>{}} />);
`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "RefreshCard", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => {
  if (!/Could not parse CSS|Not implemented: window\./.test(String(error))) throw error;
});
const dom = new JSDOM(`<!doctype html><html><body><div id="host"></div></body></html>`, {
  url: "https://refresh.test/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
  virtualConsole,
});
const { window } = dom;
const document = window.document;
window.eval(bundle);

const tick = (ms = 10) => new Promise((done) => setTimeout(done, ms));
async function until(read, description, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${description}`);
    await tick();
  }
}
const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
const button = (where, label) => [...where.querySelectorAll("button")].find((one) => one.textContent.trim() === label) ?? null;
const typeInto = (element, value) => {
  const proto = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
};
const enabled = (label) => {
  const found = button(document, label);
  return found && !found.disabled ? found : null;
};

// ---------------------------------------------------------------- fixture
const at = "2026-11-14T00:01:00Z";
const reason = (message, messageZh) => ({ code: "why", message, messageZh });
const refreshOf = (extra = {}) => ({
  version: 3, cadence: { every: "day", at: "08:00" }, zone: "local", utcOffset: "+08:00",
  instruction: "Summarise the news and new papers.", enabled: true, pausedReason: null, weeklyRuns: 7,
  nextAt: "2026-11-15T00:00:00Z", lastSlot: "2026-11-14T00:00:00Z",
  run: { slot: "2026-11-14T00:00:00Z", missed: 0, state: "refreshed", endedAt: at },
  recent: [{ slot: "2026-11-13T00:00:00Z", state: "failed", missed: 0, reason: reason("Its owner was busy", "主人一直在忙") },
    { slot: "2026-11-14T00:00:00Z", state: "refreshed", missed: 0 }],
  failures: 0, waiting: null, versions: 2,
  createdAt: "2026-11-01T00:00:00Z", createdBy: "a", updatedAt: at, ...extra,
});
const body = (lead) => ({ root: "body", elements: {
  body: { type: "BriefBody", props: { summary: { lead: "lead" } }, children: ["lead", "more"] },
  lead: { type: "Markdown", props: { text: lead } },
  more: { type: "Markdown", props: { text: "Everything else is on the report page." } },
} });
const section = (extra = {}) => ({
  id: 51, key: "digest/news", kind: "report", title: "Today's news and papers", version: 3,
  owner: { agentId: "a", name: "Mori", state: "active" }, updatedAt: at, updatedTurnId: "t1",
  body: body("Three stories worth reading, and five new papers."), attachments: [], refs: {}, seen: null, history: false,
  refresh: refreshOf(), ...extra,
});
const panel = { project: { id: "p1", name: "Daily digest" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
  errors: [], pending: [], jobs: [], brief: { version: 5, sections: [section()], history: [] }, unseen: 0, missing: [] };
const home = { generatedAt: at, order: ["p1"], needsYou: [], projects: [panel] };

// ------------------------------------------------------------- mock Core
const calls = [];
let failure = null;
window.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method ?? "GET";
  const called = { url, method, body: init.body ? JSON.parse(init.body) : null };
  calls.push(called);
  const answer = (status, value) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  const fail = failure;
  failure = null;
  if (fail) return answer(fail.status, fail.body);
  if (method === "PUT") return answer(200, { ...refreshOf(), version: called.body.version + 1 });
  if (method === "DELETE") return answer(200, { removed: true });
  if (method === "POST" && url.endsWith("/now")) return answer(200, { ...refreshOf(), version: 4 });
  if (url.endsWith("/versions")) {
    return answer(200, { projectId: "p1", identity: 51, key: "digest/news", versions: [
      { version: 3, at, title: "Today's news and papers", lead: "Three stories worth reading, and five new papers.", live: true },
      { version: 2, at: "2026-11-13T00:00:00Z", title: "Yesterday's news", lead: "Two stories and three papers.", live: false, historyReason: "refreshed" },
    ] });
  }
  if (/\/versions\/2$/.test(url)) {
    return answer(200, section({ version: 2, title: "Yesterday's news", history: true, historyReason: "refreshed",
      body: body("Two stories worth reading, and three new papers.") }));
  }
  if (url.startsWith("/api/")) return answer(200, {});
  return answer(404, { error: "not in the fixture" });
};

test.after(() => dom.window.close());

test("a card's tag says how often and its foot says what the last run did", async () => {
  window.mountCard(section());
  await until(() => text(".home-refresh-tag"), "the schedule tag");
  assert.equal(text(".home-refresh-tag"), "Daily 08:00");
  assert.match(text(".home-refresh-state"), /^Refreshed /);
  assert.match(text(".home-refresh-next"), /^Next /);
  // A paused card says so, and offers no next run.
  window.mountCard(section({ refresh: refreshOf({ enabled: false, pausedReason: reason("Paused after 3 failures in a row", "连续失败 3 次，已自动暂停") }) }));
  await until(() => text(".home-refresh-tag.is-paused"), "the paused tag");
  assert.equal(text(".home-refresh-tag"), "Paused");
  assert.equal(text(".home-refresh-state"), "Paused · Paused after 3 failures in a row");
  assert.equal(document.querySelector(".home-refresh-next"), null);
  // A run that made up missed slots says how many.
  window.mountCard(section({ refresh: refreshOf({ run: { slot: "2026-11-14T00:00:00Z", missed: 2, state: "refreshed", endedAt: at } }) }));
  await until(() => text(".home-refresh-state.is-caughtUp"), "the catch-up state");
  assert.match(text(".home-refresh-state"), /Caught up .* · 2 missed/);
});

test("the alarm opens the panel; a read-only Home offers neither", async () => {
  window.mountCard(section());
  await until(() => document.querySelector(".home-refresh-open"), "the alarm");
  const alarm = document.querySelector(".home-refresh-open");
  assert.equal(alarm.getAttribute("aria-expanded"), "false");
  assert.match(alarm.getAttribute("aria-label"), /Refresh schedule/);
  alarm.click();
  await until(() => document.querySelector(".home-refresh-panel"), "the panel");
  assert.equal(document.querySelector(".home-refresh-open").getAttribute("aria-expanded"), "true");
  assert.ok(document.querySelector(`#${document.querySelector(".home-refresh-open").getAttribute("aria-controls")}`), "aria-controls names the panel");
  assert.equal(document.querySelector(".home-refresh-panel").id, document.querySelector(".home-refresh-open").getAttribute("aria-controls"));
  // The panel's fields are the schedule Core gave.
  assert.equal(document.querySelector('.home-refresh-frequency [aria-pressed="true"]').textContent.trim(), "Every day");
  assert.equal(document.querySelector(".home-refresh-instruction textarea").value, "Summarise the news and new papers.");
  assert.equal(document.querySelectorAll(".home-refresh-recent li").length, 2);
  window.mountCard(section(), true);
  await until(() => text(".home-refresh-tag"), "the read-only card");
  assert.equal(document.querySelector(".home-refresh-open"), null);
});

test("Save sends the cadence, zone and instruction the user chose, against the version read", async () => {
  calls.length = 0;
  window.mountPanel(section(), () => {});
  await until(() => document.querySelector(".home-refresh-panel"), "the panel");
  const frequency = document.querySelector(".home-refresh-frequency");
  button(frequency, "Every week").click();
  await tick();
  const day = (name) => until(() => [...document.querySelectorAll(".home-refresh-choices button")].find((one) => one.textContent.trim() === name), `the ${name} button`);
  (await day("Mon")).click();
  (await day("Wed")).click();
  const instruction = document.querySelector(".home-refresh-instruction textarea");
  typeInto(instruction, "Only what is new since the last issue.");
  await tick();
  button(document, "Save").click();
  const put = await until(() => calls.find((call) => call.method === "PUT"), "the save");
  assert.equal(put.url, "/api/projects/p1/brief/refreshes/51");
  assert.deepEqual(put.body, {
    version: 3,
    cadence: { every: "week", at: "08:00", days: [1, 3] },
    zone: "local",
    instruction: "Only what is new since the last issue.",
  });
});

test("a week with no day, or no time, is said here and nothing is sent", async () => {
  calls.length = 0;
  window.mountPanel(section(), () => {});
  await until(() => document.querySelector(".home-refresh-panel"), "the panel");
  button(document.querySelector(".home-refresh-frequency"), "Every week").click();
  await tick();
  button(document, "Save").click();
  await until(() => document.querySelector(".inline-error"), "the refusal");
  assert.equal(text(".inline-error"), "Choose at least one day.");
  assert.equal(calls.filter((call) => call.method === "PUT").length, 0);
});

test("Pause, Refresh now and Remove schedule each call their own route; Remove closes the panel", async () => {
  calls.length = 0;
  let closed = 0;
  window.mountPanel(section(), () => {}, () => closed++);
  await until(() => document.querySelector(".home-refresh-panel"), "the panel");
  button(document, "Pause").click();
  const pause = await until(() => calls.find((call) => call.method === "PUT"), "the pause");
  assert.deepEqual(pause.body, { version: 3, enabled: false });
  const nowButton = await until(() => enabled("Refresh now"), "Refresh now back after the pause");
  nowButton.click();
  const now = await until(() => calls.find((call) => call.method === "POST"), "refresh now");
  assert.equal(now.url, "/api/projects/p1/brief/refreshes/51/now");
  assert.ok(now.body.requestId.length > 0);
  (await until(() => enabled("Remove schedule"), "Remove schedule back")).click();
  const removed = await until(() => calls.find((call) => call.method === "DELETE"), "the removal");
  assert.equal(removed.url, "/api/projects/p1/brief/refreshes/51");
  await until(() => closed === 1, "the panel closing");
});

test("a paused schedule offers Resume, not Refresh now (Core refuses that with 409)", async () => {
  window.mountPanel(section({ refresh: refreshOf({ enabled: false, pausedReason: reason("Paused after 3 failures in a row", "连续失败 3 次，已自动暂停") }) }), () => {});
  await until(() => document.querySelector(".home-refresh-panel"), "the panel");
  assert.equal(button(document, "Refresh now"), null);
  assert.ok(button(document, "Resume"));
  assert.equal(button(document, "Pause"), null);
});

test("a version conflict shows Core's answer and asks Home to read again", async () => {
  calls.length = 0;
  let changed = 0;
  failure = { status: 409, body: { error: { message: "This schedule changed since the page read it; it is as it is now.", code: "version_conflict" } } };
  window.mountPanel(section(), () => changed++);
  await until(() => document.querySelector(".home-refresh-panel"), "the panel");
  button(document, "Pause").click();
  await until(() => document.querySelector(".inline-error"), "the conflict");
  assert.match(text(".inline-error"), /changed since the page read it/);
  await until(() => changed > 0, "Home reading again");
});

test("the report page lists this issue and Core's past ones; a past issue is read whole and read only", async () => {
  calls.length = 0;
  window.mountReport(home, { workspaceId: "ws-1", projectId: "p1", key: "digest/news", version: 3, sectionId: 51 });
  await until(() => document.querySelector(".home-refresh-issues select"), "the issue list");
  const select = await until(() => {
    const found = document.querySelector(".home-refresh-issues select");
    return found && !found.disabled && found.options.length === 2 ? found : null;
  }, "both issues");
  assert.match(select.options[0].textContent, /^This issue ·/);
  assert.match(select.options[1].textContent, /Yesterday's news|Two stories and three papers/);
  assert.equal(document.querySelector("h1").textContent, "Today's news and papers");
  // The schedule panel is here too, under the title, folded until asked for.
  assert.equal(document.querySelector(".home-refresh-panel"), null);
  button(document.querySelector(".report-issue-row"), "Refresh schedule").click();
  await until(() => document.querySelector(".home-refresh-panel.is-report"), "the report's schedule panel");
  // Open the past issue: Core's version, said as such, with no Seen or Reply.
  select.value = "2";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  const banner = await until(() => document.querySelector(".report-issue-banner"), "the past-issue banner");
  assert.match(banner.textContent, /This is the issue from/);
  assert.match(banner.textContent, /Read only/);
  await until(() => document.querySelector("h1").textContent === "Yesterday's news", "the past issue's title");
  assert.match(document.querySelector(".report-lead").textContent, /Two stories worth reading/);
  assert.equal(document.querySelector(".home-seen"), null);
  assert.equal(document.querySelector(".home-reply-open"), null);
  assert.equal(document.querySelector(".report-refresh-toggle"), null);
  const read = calls.find((call) => call.url === "/api/projects/p1/brief/refreshes/51/versions/2");
  assert.ok(read, "the past issue read from Core");
  // Back to this issue.
  button(banner, "Back to this issue").click();
  await until(() => document.querySelector("h1").textContent === "Today's news and papers", "the live issue");
  assert.equal(document.querySelector(".report-issue-banner"), null);
});

test("a report kept in history keeps its schedule and issue list, with this issue selected", async () => {
  const past = section({ version: 2, history: true, historyReason: "seen", title: "Yesterday's news", body: body("Two stories worth reading, and three new papers.") });
  const data = { ...home, projects: [{ ...panel, brief: { version: 6, sections: [section()], history: [past] } }] };
  window.mountReport(data, { workspaceId: "ws-1", projectId: "p1", key: "digest/news", version: 2, sectionId: 51 });
  const select = await until(() => {
    const found = document.querySelector(".home-refresh-issues select");
    return found && !found.disabled && found.options.length === 2 ? found : null;
  }, "the issue list of a history report");
  assert.equal(select.value, "2");
  assert.match(select.options[0].textContent, /^This issue ·/);
  await until(() => document.querySelector("h1").textContent === "Yesterday's news", "the linked history version");
  // The schedule panel is offered here too: the card keeps its schedule in history.
  assert.ok(button(document.querySelector(".report-issue-row"), "Refresh schedule"));
});
