import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";

// YN-4: an intermediate result (status doing) in the built app against an
// in-memory Core. Its task stays in progress, and the task's detail calls the
// result a step of work that goes on, not an earlier result that work has
// moved past. A result set back to doing by hand, and a result in review,
// read as before; so does the list.
const dist = pathToFileURL(resolve(process.env.YUZUNO_UI_DIST || "dist") + "/");
const html = await readFile(new URL("index.html", dist), "utf8");
const bundle = await uiTestBundle(new URL(html.match(/src="\/(assets\/[^" ]+\.js)"/)[1], dist));
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, message, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await pause(25);
  assert.ok(predicate(), message);
}

const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
const person = { kind: "user", id: "user", name: "You" };
const executor = { kind: "agent", id: "e1", name: "T-1 · Executor" };
const result = (status, summary, version) => ({
  id: `result-${status}-${version}`, summary, links: [], taskVersion: version, status,
  reportedAt: ago(30), reportedBy: executor, dispatchId: "d1",
});
const task = (id, patch) => ({
  id, title: `Task ${id}`, description: "Deliver it in slices", status: "doing", version: 3, projectId: "p",
  progress: "", blocker: "", result: null, github: [],
  createdAt: ago(5000), updatedAt: ago(30), createdBy: person, updatedBy: person, ...patch,
});
const fixture = () => [
  // The executor's plan, submitted as a step: its task is still in progress.
  task("T-1", { result: result("doing", "The plan, for your approval before any code.", 3) }),
  // A result submitted for review, then set back to doing by hand.
  task("T-2", { version: 4, result: result("review", "Slice 1 for review.", 3) }),
  task("T-3", { status: "review", result: result("review", "All slices delivered.", 3) }),
];

async function mount({ language } = {}) {
  const errors = [];
  const tasks = fixture();
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4491/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  w.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.EventSource = class { addEventListener() {} close() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  const project = { id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" };
  const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
  w.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.endsWith("/workspace")) return response({ workspace: { id: "fixture" }, agents: [], projects: [project], runtime: { connected: false }, defaultCwd: "/fixture" });
    if (url.endsWith("/catchup")) return response({ items: [], coverage: {} });
    if (url.endsWith("/machines")) return response({ machines: [] });
    if (url.endsWith("/task_list")) return response({ tasks, counts: { doing: 2, review: 1 }, hasMore: false });
    if (url.endsWith("/task_get")) return response({ task: tasks.find((t) => t.id === body.taskId), activities: [], executions: [], hasMore: false });
    if (url.includes("/github_")) return response({ links: [], repositories: [], refreshing: false });
    return response({});
  };
  const doc = w.document;
  const tasksButton = language === "zh-Hans" ? "任务与消息" : "Tasks & messages";
  const button = (text) => [...doc.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  if (language) w.localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
  try {
    w.eval(bundle);
    await waitFor(() => { const b = button(tasksButton); return b && !b.disabled; }, "workspace ready");
    button(tasksButton).click();
    await waitFor(() => doc.querySelector('button[data-task-id="T-1"]'), "task list loaded");
  } catch (error) {
    w.close();
    throw error;
  }
  const row = (id) => doc.querySelector(`.collab-task-card[data-task-id="${id}"]`);
  const detail = () => doc.querySelector(".collab-detail");
  return {
    errors, row, detail,
    async open(id) {
      row(id).focus();
      row(id).click();
      await waitFor(() => detail()?.querySelector(`.collab-task-title [data-task-id="${id}"]`), `${id} opened`);
    },
    headings: () => [...detail().querySelectorAll("h4")].map((h) => h.textContent.trim()),
    context: () => detail().querySelector(".task-outcome .outcome-context")?.textContent.trim() ?? "",
    close: () => w.close(),
  };
}

test("an intermediate result is headed as a step of work that goes on, not as an earlier result", async () => {
  const p = await mount();
  try {
    await p.open("T-1");
    const headings = p.headings();
    assert.ok(headings.includes("Step result"), `the step's heading: ${headings.join(" | ")}`);
    assert.ok(!headings.includes("Earlier result") && !headings.includes("The result"), headings.join(" | "));
    assert.equal(p.context(), "An intermediate result; the work continues.", "the line under it says the work goes on");
    // Set back to doing by hand after a result for review: as before.
    await p.open("T-2");
    assert.ok(p.headings().includes("Earlier result"), p.headings().join(" | "));
    assert.equal(p.context(), "Work has continued since this report. See the task's current progress and owner.");
    // A result in review is the result, with no line about work going on.
    await p.open("T-3");
    assert.ok(p.headings().includes("The result"), p.headings().join(" | "));
    assert.equal(p.context(), "", "a result in review has no such line");
    // The list is unchanged: only the result in review has the Result chip.
    const chipped = ["T-1", "T-2", "T-3"].filter((id) => p.row(id)?.querySelector(".collab-has-result"));
    assert.deepEqual(chipped, ["T-3"]);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("in Chinese, an intermediate result is a 阶段结果 whose work goes on", async () => {
  const p = await mount({ language: "zh-Hans" });
  try {
    await p.open("T-1");
    const headings = p.headings();
    assert.ok(headings.includes("阶段结果"), `the step's heading: ${headings.join(" | ")}`);
    assert.ok(!headings.includes("之前的结果"), headings.join(" | "));
    assert.equal(p.context(), "这是阶段结果，工作仍在继续。");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
