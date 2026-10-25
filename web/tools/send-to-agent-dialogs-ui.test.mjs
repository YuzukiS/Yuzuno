import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";
import { composerText } from "./composer-driver.mjs";

// Send to Agent (T-152) out of the Tasks and Jobs dialogs, which cover the
// rail: a drag shows the drop strip, and a drop adds a reference to that
// Agent's draft without touching the task or sending anything.
const dist = pathToFileURL(resolve(process.env.YUZUNO_UI_DIST || "dist") + "/");
const html = await readFile(new URL("index.html", dist), "utf8");
const bundle = await uiTestBundle(new URL(html.match(/src="\/(assets\/[^" ]+\.js)"/)[1], dist));
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function waitFor(read, message, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(message);
    await pause(25);
  }
}

const person = { kind: "user", id: "user", name: "You" };
const agent = (id, name) => ({
  id, name, goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p",
});
const agents = [agent("a", "Mori"), agent("b", "Hana")];
const task = {
  id: "T-7", title: "Tidy the rail", description: "Make rows quieter.", status: "doing", version: 3, projectId: "p",
  assigneeAgentId: "a", assignee: { kind: "agent", id: "a", name: "Mori" }, progress: "Halfway", blocker: "", result: null, github: [],
  createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", createdBy: person, updatedBy: person,
};
const job = {
  id: "job-1", name: "Build the UI", status: "succeeded", reason: "success", agentId: "a", agent: { name: "Mori" }, taskRef: "T-7",
  cwd: "/w", machine: { id: "local-1", name: "Host" }, executor: null, resources: { cpuMillis: 1000, memoryMiB: 512, swapMiB: 0 },
  reservation: { cpuMillis: 1000, memoryMiB: 512, swapMiB: 0 }, createdAt: "2026-10-20T06:00:00Z", startedAt: "2026-10-20T06:00:01Z",
  finishedAt: "2026-10-20T06:01:00Z", reserved: false, cursor: 1, requestId: "r",
  result: { reason: "success", artifacts: [{ path: "out/report.json", ok: true, absolutePath: "/w/out/report.json" }] },
};
const budget = {
  machine: { name: "Host", memoryAvailableMiB: 4096, scope: "" },
  budget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 }, reserved: { cpuMillis: 0, memoryMiB: 0, swapMiB: 0 },
  activeCount: 0, queuedCount: 0,
};

async function mount({ turns = [] } = {}) {
  const errors = [];
  const calls = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4492/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  w.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.EventSource = class { addEventListener() {} close() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  // Saved under the Workspace and Agent it was written in (T-195).
  w.localStorage.setItem(
    `yuzuno.composer.v1:${JSON.stringify(["fixture", "b"])}`,
    JSON.stringify({ version: 1, nextNumber: 1, parts: [{ kind: "text", text: "Hana's own note." }] }),
  );
  const project = { id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" };
  const response = (body) => ({ ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
  w.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    const path = new URL(String(url), "http://127.0.0.1:4492").pathname;
    if (path === "/api/workspace") return response({ workspace: { id: "fixture" }, agents, projects: [project], runtime: { connected: true }, defaultCwd: "/w" });
    const detail = /^\/api\/agents\/([ab])$/.exec(path);
    if (detail) return response({ agent: agents.find((a) => a.id === detail[1]), pending: [], artifacts: [], turns: detail[1] === "a" ? turns : [] });
    if (path === "/api/collaboration/task_list") return response({ tasks: [task], counts: { doing: 1 }, hasMore: false });
    if (path === "/api/collaboration/task_get") return response({ task, activities: [], executions: [], hasMore: false });
    if (path.startsWith("/api/collaboration/github_")) return response({ links: [], repositories: [], refreshing: false });
    if (path === "/api/jobs") return response({ jobs: [job], hasMore: false, nextBefore: null });
    if (path === "/api/jobs/budget") return response(budget);
    return response({});
  };
  w.eval(bundle);
  const doc = w.document;
  const button = (text) => [...doc.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  await waitFor(() => doc.querySelector('[data-composer-input][aria-label="Message Mori"]'), "Mori is open");
  return { w, doc, calls, errors, button, close: () => w.close() };
}
function dragData() {
  const data = new Map();
  return {
    types: [], dropEffect: "none", effectAllowed: "uninitialized",
    setData(type, value) { data.set(type, value); if (!this.types.includes(type)) this.types.push(type); },
    getData: (type) => data.get(type) ?? "",
  };
}
function fire(page, target, type, dataTransfer) {
  const event = new page.w.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(event);
  return event;
}
const chip = (page, id) => page.doc.querySelector(`.handoff-strip .handoff-chip[data-agent-id="${id}"]`);
// Reads and opening Hana are fine; changing a task or sending a message is not.
const writes = (page) => page.calls.filter((c) => /task_(dispatch|update|claim|create|comment|submit)|\/messages$|\/turns$/.test(c.url));

test("a task card dragged out of the board drops on an Agent in the strip as a reference, not an assignment", async () => {
  const page = await mount();
  try {
    await waitFor(() => page.button("Tasks & messages") && !page.button("Tasks & messages").disabled, "the board can open");
    page.button("Tasks & messages").click();
    const card = await waitFor(() => page.doc.querySelector('.collab-task-card[data-task-id="T-7"]'), "the task is listed");
    assert.equal(page.doc.querySelector(".handoff-strip"), null, "no strip until a drag starts");
    const drag = dragData();
    fire(page, card, "dragstart", drag);
    await pause();
    assert.deepEqual(JSON.parse(drag.getData("application/x-yuzuno-handoff")).taskId, "T-7");
    await waitFor(() => chip(page, "b"), "the strip offers the open Agents");
    assert.ok(chip(page, "a"), "its assignee is offered too: a reference is not a dispatch");
    assert.equal(fire(page, chip(page, "b"), "dragover", drag).defaultPrevented, true);
    await pause();
    assert.ok(chip(page, "b").classList.contains("handoff-accept"));
    fire(page, chip(page, "b"), "drop", drag);
    const composer = await waitFor(() => page.doc.querySelector('[data-composer-input][aria-label="Message Hana"]'), "Hana opens");
    await pause(80);
    const text = composerText(composer);
    assert.ok(text.startsWith("Hana's own note.\n\nFor reference: task T-7 “Tidy the rail”, status doing, assigned to Mori, version 3"), text);
    assert.match(text, /This does not assign it to you\./);
    assert.equal(page.doc.querySelector(".collaboration"), null, "the board closed");
    fire(page, page.doc.body, "dragend", drag);
    await pause();
    assert.equal(page.doc.querySelector(".handoff-strip"), null, "the strip is gone");
    assert.deepEqual(writes(page), []);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a Job row dragged out of the Jobs dialog drops on an Agent; a drag let go nowhere leaves nothing", async () => {
  const page = await mount();
  try {
    page.doc.querySelector('button[aria-label="Jobs"]').click();
    const row = await waitFor(() => [...page.doc.querySelectorAll(".job-row")].find((r) => r.textContent.includes("Build the UI")), "the Job is listed");
    // Cancelled: the strip comes and goes, and no draft changes.
    const cancelled = dragData();
    fire(page, row, "dragstart", cancelled);
    await waitFor(() => chip(page, "b"), "the strip shows");
    fire(page, row, "dragend", cancelled);
    await pause();
    assert.equal(page.doc.querySelector(".handoff-strip"), null);
    const drag = dragData();
    fire(page, row, "dragstart", drag);
    await waitFor(() => chip(page, "b"), "the strip shows again");
    fire(page, chip(page, "b"), "dragover", drag);
    fire(page, chip(page, "b"), "drop", drag);
    const composer = await waitFor(() => page.doc.querySelector('[data-composer-input][aria-label="Message Hana"]'), "Hana opens");
    await pause(80);
    const text = composerText(composer);
    assert.ok(text.startsWith("Hana's own note.\n\nFor reference: Job “Build the UI” (job-1), succeeded"), text);
    assert.match(text, /Artifacts, on this Core’s host: \/w\/out\/report\.json\./);
    assert.equal(page.doc.querySelector(".jobs-dialog"), null, "the Jobs dialog closed");
    assert.deepEqual(writes(page), []);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

// T-189: Send to Agent follows the interface language, changed in another
// window. Agent and machine names stay as they are; nothing is sent.
const speak = (page, language) => {
  page.w.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  page.w.dispatchEvent(new page.w.StorageEvent("storage", { key: "yuzuno.language" }));
};
test("Send to Agent follows a language change: its open menu, a refusal on the rail and the drop strip; nothing is sent (T-189)", async () => {
  const reply = { id: "turn-1", status: "completed", items: [{ id: "reply-1", type: "agentMessage", text: "The rail is quieter now." }] };
  const page = await mount({ turns: [reply] });
  const sendButton = () => page.doc.querySelector(".reply-actions .send-to-agent-button");
  const hanaDraft = page.w.localStorage.getItem("yuzuno.composer.v1:b");
  try {
    await waitFor(sendButton, "Mori's reply offers Send to Agent");
    sendButton().click();
    await waitFor(() => page.doc.querySelector(".send-to-agent-menu"), "the menu opens");
    speak(page, "zh-Hans");
    await pause();
    const menu = page.doc.querySelector(".send-to-agent-menu");
    assert.ok(menu, "the menu stays open");
    assert.equal(menu.getAttribute("aria-label"), "加入某个 Agent 的草稿");
    assert.equal(menu.querySelector(".send-to-agent-note").textContent, "加入该 Agent 的草稿。在你发送之前，不会发出任何内容。");
    assert.deepEqual([...menu.querySelectorAll("[role=menuitem]")].map((b) => b.textContent), ["HanaCore 主机"], "Mori's own reply is not offered to Mori");
    assert.equal(sendButton().textContent, "发送给 Agent");
    assert.match(sendButton().title, /^发送给 Agent：选择一个 Agent/);
    // Dragged onto Mori, the rail says why not.
    const own = dragData();
    fire(page, sendButton(), "dragstart", own);
    await pause();
    fire(page, page.doc.querySelector('.agent-row[data-agent-id="a"]'), "dragover", own);
    await pause();
    assert.equal(page.doc.querySelector('.agent-row[data-agent-id="a"] .handoff-hint').textContent, "这本来就来自 Mori 的会话。");
    fire(page, page.doc.body, "dragend", own);
    await pause();
    // A task card dragged out of the board: the strip and its chips.
    await waitFor(() => page.button("任务与消息") && !page.button("任务与消息").disabled, "the board can open");
    page.button("任务与消息").click();
    const card = await waitFor(() => page.doc.querySelector('.collab-task-card[data-task-id="T-7"]'), "the task is listed");
    const drag = dragData();
    fire(page, card, "dragstart", drag);
    const strip = await waitFor(() => page.doc.querySelector(".handoff-strip"), "the strip opens");
    assert.equal(strip.getAttribute("aria-label"), "可以放下的 Agent");
    assert.equal(strip.querySelector(".handoff-strip-label").textContent, "放到某个 Agent 上，即可加入其草稿");
    assert.equal(chip(page, "b").title, "加入 Hana 的草稿");
    assert.equal(chip(page, "b").textContent, "HanaCore 主机");
    fire(page, page.doc.body, "dragend", drag);
    await pause();
    assert.equal(page.w.localStorage.getItem("yuzuno.composer.v1:b"), hanaDraft, "Hana's draft is as it was");
    assert.deepEqual(writes(page), []);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});
