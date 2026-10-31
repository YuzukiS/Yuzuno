import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { outcomeFixture } from "./task-outcome-fixture.mjs";
// Mount the production component with an explicit React root so even failed
// nested-dialog assertions unmount effects before the JSDOM window closes.
// Whole-product bundle loading and layout are covered in task-outcome-check.
const web = fileURLToPath(new URL("../", import.meta.url));
await mkdir(resolve(web, "node_modules/.cache"), { recursive: true });
const temp = await mkdtemp(resolve(web, "node_modules/.cache/outcome-ui-"));
let bundle;
try {
  const entry = resolve(temp, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {CollaborationBoard} from ${JSON.stringify(resolve(web, "src/CollaborationBoard.tsx"))};
const root=createRoot(document.getElementById('root'));
window.renderBoard=props=>root.render(<CollaborationBoard {...props}/>);
window.unmountBoard=()=>root.unmount();`,
  );
  const output = await build({
    root: web,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      lib: { entry, name: "OutcomeUI", formats: ["iife"] },
    },
  });
  bundle = (Array.isArray(output) ? output[0] : output).output.find(
    (item) => item.type === "chunk",
  ).code;
} finally {
  await rm(temp, { recursive: true, force: true });
}
const pause = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn, message) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await pause();
  }
  console.error(`Outcome wait failed: ${message}`);
  assert.ok(fn(), message);
}
async function mount() {
  const fixture = outcomeFixture(),
    errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', {
    url: "http://localhost:4491",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const w = dom.window,
    doc = w.document;
  let events;
  w.matchMedia = (media) => ({
    media,
    matches: /reduced-motion/.test(media),
    addEventListener() {},
    removeEventListener() {},
  });
  w.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  w.IntersectionObserver = w.ResizeObserver;
  w.EventSource = class {
    constructor() {
      events = this;
    }
    addEventListener() {}
    close() {}
  };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  w.fetch = async (url, init = {}) => {
    const path = new URL(url, w.location.href).pathname,
      body = init.body ? JSON.parse(init.body) : {};
    const data = fixture.answer(path, body);
    return {
      ok: !data.error,
      status: data.error ? 500 : 200,
      json: async () => structuredClone(data),
      text: async () => JSON.stringify(data),
    };
  };
  const button = (name, root = doc) =>
    [...root.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === name,
    );
  w.eval(bundle);
  let revision = 0;
  const render = () =>
    w.renderBoard({
      open: true,
      onOpenChange() {},
      agents: fixture.agents,
      projects: fixture.projects,
      onOpenAgent() {},
      revision,
    });
  const refresh = () => {
    revision++;
    render();
  };
  render();
  try {
    await until(() => doc.querySelector('[data-task-id="T-1"]'), "tasks");
  } catch (error) {
    w.unmountBoard();
    w.close();
    throw error;
  }
  const openTask = async (id) => {
    doc.querySelector(`button[data-task-id="${id}"]`).click();
    await until(
      () => doc.querySelector(`.collab-task-title [data-task-id="${id}"]`),
      "task opened",
    );
  };
  const openOutcome = async () => {
    const trigger = button("Outcome & evidence");
    trigger.focus();
    trigger.click();
    await until(
      () => doc.querySelector('.outcome-drawer [role="tabpanel"]'),
      "outcome loaded",
    );
    return trigger;
  };
  return {
    w,
    doc,
    fixture,
    errors,
    button,
    openTask,
    openOutcome,
    refresh,
    close: () => {
      w.unmountBoard();
      w.close();
    },
  };
}
test("outcome first, author claims separate, immutable version and matched Job are not acceptance", async () => {
  const p = await mount();
  try {
    await p.openTask("T-1");
    const card = p.doc.querySelector(".task-outcome");
    assert.match(card.textContent, /v4/);
    assert.doesNotMatch(card.textContent, /v7/);
    assert.match(card.textContent, /Current ownerIris/);
    assert.match(card.textContent, /Author's suggested next personMina/);
    assert.match(card.textContent, /手机版触控/);
    assert.match(card.textContent, /Author reports 1 of 2 items met/);
    assert.equal(
      p.fixture.calls.filter((c) => c.path.endsWith("task_result_get")).length,
      0,
      "evidence read on demand",
    );
    const trigger = await p.openOutcome();
    const drawer = p.doc.querySelector(".outcome-drawer");
    assert.match(drawer.textContent, /No item-level verification record/);
    assert.match(drawer.textContent, /No explicit acceptance record/);
    p.button("Item by item", drawer).click();
    await pause();
    assert.match(drawer.textContent, /桌面与手机均可/);
    assert.doesNotMatch(drawer.textContent, /任务之后编辑的说明/);
    const criterion = drawer.querySelector(".outcome-criterion");
    criterion.open = true;
    assert.match(criterion.textContent, /Author reports met/);
    assert.match(criterion.textContent, /Matches the recorded artifact/);
    assert.match(criterion.textContent, /file has not been read again/);
    assert.match(criterion.textContent, /not behavioral acceptance/);
    assert.equal(
      criterion.querySelector("a[download]").getAttribute("href"),
      "/api/jobs/job-synthetic/artifacts/0",
    );
    assert.equal(
      criterion.querySelectorAll(".outcome-facts dt").length,
      5,
      "no invented checkedAt timestamp",
    );
    p.button("Versions", drawer).click();
    await pause();
    const old = [...drawer.querySelectorAll(".outcome-history article")].find(
      (e) => e.textContent.includes("v2"),
    );
    p.button("Item by item", old).click();
    await until(
      () =>
        drawer
          .querySelector(".outcome-record-id")
          ?.textContent.includes("result-earlier"),
      "old selected",
    );
    assert.match(drawer.textContent, /earlier submission/);
    assert.match(drawer.textContent, /Artifact identity does not match/);
    assert.equal(
      drawer.querySelectorAll("a[download]").length,
      0,
      "old mismatch has no download",
    );
    drawer.querySelector('[aria-label="Close outcome details"]').click();
    await until(() => !p.doc.querySelector(".outcome-drawer"), "closed");
    await until(() => p.doc.activeElement === trigger, "focus restored");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
test("legacy prose and done-like claims remain unknown; empty and failed reads stay explicit", async () => {
  const p = await mount();
  try {
    await p.openTask("T-2");
    await p.openOutcome();
    let drawer = p.doc.querySelector(".outcome-drawer");
    assert.match(drawer.textContent, /Version not recorded/);
    assert.match(drawer.textContent, /No explicit acceptance record/);
    p.button("Item by item", drawer).click();
    await pause();
    assert.match(drawer.textContent, /No itemized author report/);
    drawer.querySelector('[aria-label="Close outcome details"]').click();
    await until(() => !p.doc.querySelector(".outcome-drawer"), "closed");
    await p.openTask("T-3");
    assert.match(
      p.doc.querySelector(".task-outcome").textContent,
      /No outcome submitted/,
    );
    p.fixture.failReads();
    p.button("Outcome & evidence").click();
    await until(
      () => p.doc.querySelector('.outcome-drawer [role="alert"]'),
      "read failure",
    );
    drawer = p.doc.querySelector(".outcome-drawer");
    assert.match(drawer.textContent, /synthetic read failure/);
    assert.equal(
      drawer.querySelectorAll('[role="tabpanel"]').length,
      0,
      "failure is not a successful empty record",
    );
    p.fixture.failReads(false);
    drawer.querySelector('[aria-label="Refresh recorded evidence"]').click();
    await until(
      () => drawer.querySelector('[role="tabpanel"]'),
      "retry loaded",
    );
    assert.match(drawer.textContent, /No outcome submitted/);
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});
test("density, keyboard tabs and background refresh retain result form drafts and fixed evidence selection", async () => {
  const p = await mount();
  try {
    await p.openTask("T-1");
    const order = () =>
      [...p.doc.querySelectorAll(".outcome-overview dt")].map(
        (n) => n.textContent,
      );
    const before = order();
    p.button("Compact").click();
    await pause();
    assert.deepEqual(order(), before);
    p.button("Update result").click();
    await pause();
    const summary = p.doc.querySelector(".collab-result textarea");
    Object.getOwnPropertyDescriptor(
      p.w.HTMLTextAreaElement.prototype,
      "value",
    ).set.call(summary, "draft that stays");
    summary.dispatchEvent(new p.w.Event("input", { bubbles: true }));
    summary.focus();
    p.fixture.tasks[0].version++;
    p.doc.querySelector('[aria-label="Refresh task details"]').click();
    await pause(100);
    assert.equal(summary.value, "draft that stays");
    assert.match(
      p.doc.querySelector(".outcome-editor").textContent,
      /checks\/desktop.json/,
    );
    const trigger = await p.openOutcome();
    const drawer = p.doc.querySelector(".outcome-drawer");
    const first = drawer.querySelector('[role="tab"]');
    first.focus();
    first.dispatchEvent(
      new p.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await pause();
    assert.equal(p.doc.activeElement.textContent, "Item by item");
    assert.equal(p.doc.activeElement.getAttribute("aria-selected"), "true");
    p.fixture.addNewResult();
    p.refresh();
    await pause(200);
    assert.equal(
      drawer
        .querySelector(".outcome-record-id")
        ?.textContent.includes("result-current"),
      true,
      "opened result never silently changes",
    );
    drawer.querySelector('[aria-label="Close outcome details"]').click();
    await until(() => p.doc.activeElement === trigger, "focus");
    assert.equal(summary.value, "draft that stays");
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("fresh result reads beat stale task props and idless history never becomes current by null equality", async () => {
  const p = await mount();
  try {
    await p.openTask("T-1");
    await p.openOutcome();
    let drawer = p.doc.querySelector(".outcome-drawer");
    p.fixture.addNewResult();
    drawer.querySelector('[aria-label="Refresh recorded evidence"]').click();
    await until(
      () =>
        drawer
          .querySelector(".outcome-drawer-meta")
          .textContent.includes("Historical submission"),
      "old selection stays pinned",
    );
    assert.match(
      drawer.querySelector(".outcome-record-id").textContent,
      /result-current/,
    );
    p.button("View latest outcome", drawer).click();
    await until(
      () =>
        drawer
          .querySelector(".outcome-record-id")
          .textContent.includes("result-new"),
      "new outcome selected",
    );
    assert.match(
      drawer.querySelector(".outcome-drawer-meta").textContent,
      /Latest submission/,
    );
    assert.doesNotMatch(
      drawer.querySelector(".outcome-drawer-meta").textContent,
      /Historical submission/,
    );
    assert.equal(drawer.querySelectorAll(".outcome-warning").length, 0);
    drawer.querySelector('[aria-label="Close outcome details"]').click();
    await until(() => !p.doc.querySelector(".outcome-drawer"), "closed");
    p.fixture.enableLegacyPaging();
    await p.openTask("T-2");
    await p.openOutcome();
    drawer = p.doc.querySelector(".outcome-drawer");
    p.button("Versions", drawer).click();
    await pause();
    assert.ok(
      [...drawer.querySelectorAll(".outcome-history-heading")].every(
        (e) => !e.textContent.includes("Latest submission"),
      ),
    );
    p.fixture.tasks[1].result = {
      id: "legacy-replacement",
      taskVersion: 8,
      summary: "Replacement report",
      links: [],
    };
    p.fixture.tasks[1].version = 8;
    p.button("Earlier submissions", drawer).click();
    await until(
      () =>
        drawer
          .querySelector(".outcome-drawer-meta")
          .textContent.includes("Historical submission"),
      "legacy selection survives history pagination",
    );
    p.button("Outcome & gaps", drawer).click();
    await pause();
    assert.match(
      drawer.querySelector(".outcome-author-report").textContent,
      /Legacy author/,
    );
    assert.doesNotMatch(
      drawer.querySelector(".outcome-author-report").textContent,
      /Replacement report/,
    );
    assert.deepEqual(p.errors, []);
  } finally {
    p.close();
  }
});

test("the existing result form preserves fixed artifact references and sends only author input", async () => {
  const p = await mount();
  try {
    await p.openTask("T-1");
    p.button("Update result").click();
    await until(() => p.doc.querySelector(".outcome-editor"), "editor");
    const form = p.doc.querySelector(".collab-result form");
    form.dispatchEvent(
      new p.w.Event("submit", { bubbles: true, cancelable: true }),
    );
    await until(
      () => p.fixture.calls.some((c) => c.path.endsWith("task_submit_result")),
      "submitted",
    );
    const { body } = p.fixture.calls.find((c) =>
      c.path.endsWith("task_submit_result"),
    );
    assert.equal(body.expectedVersion, 7);
    assert.equal(body.outcome.criteria.length, 2);
    assert.deepEqual(
      body.outcome.criteria[0].artifacts,
      p.fixture.current.outcome.criteria[0].artifacts,
    );
    assert.equal(body.outcome.nextAgentId, "writer");
    assert.equal(
      Object.hasOwn(body.outcome, "nextAgent"),
      false,
      "actor snapshot belongs to Core",
    );
    assert.equal(
      Object.hasOwn(body, "acceptanceContext"),
      false,
      "acceptance snapshot belongs to Core",
    );
  } finally {
    p.close();
  }
});
