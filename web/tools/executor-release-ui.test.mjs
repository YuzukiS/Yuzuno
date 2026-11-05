// T-34 S4: releasing an executor from Agent management. Release is offered
// for an executor only and asks first; a released executor offers neither
// Reopen nor Release again. Core's refusal is shown as it came. Fixture HTTP
// only; no Core.
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
const fixture = await mkdtemp(path.join(cache, "executor-release-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgentManagement} from ${src("AgentManagement.tsx")};
const root=createRoot(document.getElementById('root'));
window.changes=[];
window.renderAgent=(agent)=>root.render(<AgentManagement agent={agent} disabled={false} onOpenChange={()=>{}}
  onChanged={(action,updated)=>window.changes.push({action,updated})} onRead={async()=>{}}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "ExecutorReleaseUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
async function until(check, what, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const agent = (fields) => ({
  id: "e1", name: "T-7 · Reviewer", goal: "", cwd: "/synthetic/work", model: "", color: "sage", status: "idle",
  harness: "codex", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1,
  ...fields,
});
const RELEASED = "2026-11-05T19:00:00Z";

/** `route` answers each request: [status, body]. */
function mount(route) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.matchMedia = (media) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ url, method });
    const [status, value] = route(url, method);
    return { ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value) };
  };
  window.eval(bundle);
  return { window, document: window.document, calls, errors };
}
const buttons = (page) => [...page.document.querySelectorAll("button")];
const named = (page, name) => buttons(page).find((b) => b.getAttribute("aria-label") === name || b.textContent.trim() === name);
const card = (page, title) => [...page.document.querySelectorAll(".agent-action-card")].find((b) => b.querySelector("strong")?.textContent === title);
const dialog = (page) => page.document.querySelector('[role="dialog"], [role="alertdialog"]');
const posts = (page) => page.calls.filter((c) => c.method === "POST");

async function openActions(page) {
  named(page, "Conversation actions").click();
  await until(() => dialog(page), "the actions dialog");
}

test("Release is offered for an executor, asks first, and posts once", async () => {
  const page = mount((url) => url === "/api/agents/e1/release"
    ? [200, { agentId: "e1", closedAt: RELEASED, releasedAt: RELEASED }] : [404, { error: "unexpected" }]);
  page.window.renderAgent(agent({ kind: "executor" }));
  await until(() => named(page, "Close agent"), "the close button");
  await openActions(page);
  const release = card(page, "Release executor");
  assert.ok(release, "an open executor offers Release");
  assert.match(release.textContent, /close it for good and free its slot/);
  release.click();
  await until(() => /Release T-7 · Reviewer\?/.test(dialog(page)?.textContent ?? ""), "the release question");
  assert.match(dialog(page).textContent, /can't be reopened/);
  assert.match(dialog(page).textContent, /Its task, dispatch and result stay as they are/);
  named(page, "Keep agent").click();
  await tick();
  assert.equal(posts(page).length, 0, "kept: nothing is posted");

  await openActions(page);
  card(page, "Release executor").click();
  await until(() => named(page, "Release executor"), "the confirm button");
  named(page, "Release executor").click();
  await until(() => page.window.changes.length === 1, "the release");
  assert.deepEqual(posts(page).map((c) => c.url), ["/api/agents/e1/release"]);
  const { action, updated } = page.window.changes[0];
  assert.equal(action, "release");
  assert.equal(updated.releasedAt, RELEASED, "the Agent now says when it was released");
  assert.equal(updated.closedAt, RELEASED);
  assert.equal(updated.name, "T-7 · Reviewer", "and is otherwise as it was");
  assert.deepEqual(page.errors, []);
});

test("a released executor offers neither Reopen nor Release; a closed one not released still reopens", async () => {
  const page = mount((url) => url === "/api/agents/e1/reopen" ? [200, agent({ kind: "executor" })] : [404, { error: "unexpected" }]);
  page.window.renderAgent(agent({ kind: "executor", closedAt: RELEASED, releasedAt: RELEASED }));
  await until(() => named(page, "Conversation actions"), "the actions button");
  assert.equal(named(page, "Reopen agent"), undefined, "no Reopen button for a released executor");
  assert.equal(page.document.querySelector(".agent-close-button"), null);
  await openActions(page);
  assert.equal(card(page, "Reopen agent"), undefined, "nor a Reopen card");
  assert.equal(card(page, "Release executor"), undefined, "nor Release again");
  assert.match(dialog(page).textContent, /Released: this executor stays closed\./);
  assert.ok(card(page, "Delete agent…"), "Delete is still offered");

  page.window.renderAgent(agent({ id: "e2", kind: "executor", closedAt: RELEASED }));
  await until(() => card(page, "Reopen agent"), "a closed executor's Reopen");
  assert.ok(card(page, "Release executor"), "a closed executor not released can be released");
  assert.ok(named(page, "Reopen agent"), "and its Reopen button stays");

  page.window.renderAgent(agent({ id: "s1", kind: null }));
  await until(() => card(page, "Close agent"), "a standing Agent's cards");
  assert.equal(card(page, "Release executor"), undefined, "a standing Agent is not released");
  page.window.renderAgent(agent({ id: "l1", kind: "lead" }));
  await until(() => card(page, "Close agent"), "a lead's cards");
  assert.equal(card(page, "Release executor"), undefined, "nor is a lead");
  assert.equal(posts(page).length, 0);
});

test("Core's refusal of a release is shown as it came, and the question stays", async () => {
  const refusal = "not_dispatcher: only the Agent that dispatched this executor from a template, or the user, can release it";
  const page = mount(() => [400, { error: refusal }]);
  page.window.renderAgent(agent({ kind: "executor" }));
  await until(() => named(page, "Conversation actions"), "the actions button");
  await openActions(page);
  card(page, "Release executor").click();
  await until(() => named(page, "Release executor"), "the confirm button");
  named(page, "Release executor").click();
  await until(() => page.document.querySelector('[role="alert"]'), "the refusal");
  assert.equal(page.document.querySelector('[role="alert"]').textContent, refusal);
  assert.match(dialog(page).textContent, /Release T-7 · Reviewer\?/, "the question stays, to try again or keep");
  assert.equal(page.window.changes.length, 0, "nothing changed here");
});
