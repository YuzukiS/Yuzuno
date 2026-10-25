// T-94: the usage-limit notice and the "Usage limit" setting of a Claude
// agent, in JSDOM over a scripted API. The notice says what happens and
// when, and offers continue now / don't continue; the setting is this
// agent's choice or the workspace default. Nothing else is called.
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
const fixture = await mkdtemp(path.join(cache, "quota-resume-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {QuotaResumeNotice, AutoContinueSetting} from ${JSON.stringify(path.join(root, "src/QuotaResume.tsx"))};
const root = createRoot(document.getElementById('root'));
window.renderNotice = props => root.render(<QuotaResumeNotice {...props}/>);
window.renderSetting = props => root.render(<dl><AutoContinueSetting {...props}/></dl>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "QuotaUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const reset = Math.floor(Date.now() / 1000) + 3600;
const detail = {
  agent: { id: "a", harness: "claude", status: "error", updatedAt: "1", lastSeq: 1, closedAt: null },
  turns: [{ id: "t1", status: "failed" }],
};
const waiting = { id: "i1", turnId: "t1", resetsAt: reset, dueAt: reset + 60, limitType: "five_hour", attempt: 1,
  state: "waiting", reason: null, sentTurn: null };
const view = (extra) => ({ workspace: false, agent: true, enabled: true, intent: waiting,
  stopped: { turnId: "t1", resetsAt: reset, limitType: "five_hour" }, ...extra });

function mount(responses) {
  const calls = [], errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  window.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body && JSON.parse(init.body) });
    const body = responses(url, init);
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  return { window, document: window.document, calls, errors, close: () => window.close() };
}
const text = (page) => page.document.body.textContent;
const button = (page, label) => [...page.document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);

test("a waiting continue says when, and can be cancelled or sent now", async () => {
  let current = view();
  const page = mount((url) => {
    if (url.endsWith("/cancel")) current = view({ intent: { ...waiting, state: "cancelled", reason: "You chose not to continue automatically" } });
    return current;
  });
  try {
    page.window.renderNotice({ detail, disabled: false });
    await tick();
    assert.match(text(page), /five-hour usage limit stopped this agent/);
    assert.match(text(page), /sends one message to continue the task in the same session/);
    assert.match(text(page), /approvals still ask you/);
    assert.match(button(page, "Continue now").title, /may still refuse until/, "before the reset Claude may still refuse");
    button(page, "Don’t continue automatically").click();
    await tick();
    assert.deepEqual(page.calls.at(-1), { url: "/api/agents/a/claude/auto-continue/cancel", method: "POST", body: { intentId: "i1" } });
    assert.match(text(page), /Automatic continue was cancelled: You chose not to continue automatically/);
    assert.equal(button(page, "Continue now"), undefined);
    assert.deepEqual(page.errors, []);
  } finally {
    page.close();
  }
});

test("continue now sends the waiting continue at once", async () => {
  const page = mount((url) => (url.endsWith("/now") ? view({ intent: { ...waiting, state: "sent", sentTurn: "t2" }, stopped: null }) : view()));
  try {
    page.window.renderNotice({ detail, disabled: false });
    await tick();
    button(page, "Continue now").click();
    await tick();
    assert.deepEqual(page.calls.at(-1).body, { intentId: "i1" });
    assert.match(page.calls.at(-1).url, /\/auto-continue\/now$/);
    assert.equal(page.document.querySelector(".quota-resume-notice"), null, "sent: the conversation shows the rest");
  } finally {
    page.close();
  }
});

test("a stop with automatic continue off says nothing continues, and offers it", async () => {
  let current = view({ agent: null, enabled: false, intent: null });
  // Only this Agent's own setting turns it on; the workspace default or any
  // other request leaves the view as it was.
  const own = "/api/agents/a/claude/auto-continue";
  const page = mount((url, init) => {
    if (init.method === "POST" && url === own) current = view();
    return current;
  });
  try {
    page.window.renderNotice({ detail, disabled: false });
    await tick();
    assert.match(text(page), /Nothing continues by itself/);
    button(page, "Continue automatically after the reset").click();
    await tick();
    assert.deepEqual(page.calls.at(-1), { url: own, method: "POST", body: { enabled: true } });
    assert.match(text(page), /sends one message to continue/);
    // No stop and nothing waiting: no notice at all.
    const quiet = mount(() => view({ intent: null, stopped: null }));
    quiet.window.renderNotice({ detail, disabled: false });
    await tick();
    assert.equal(quiet.document.querySelector(".quota-resume-notice"), null);
    quiet.close();
  } finally {
    page.close();
  }
});

test("a saved default whose view can't be read again says it is saved, not that it failed (T-187)", async () => {
  const current = view({ agent: null, enabled: false, intent: null, stopped: null });
  let reads = 0;
  const page = mount((url, init) => {
    if (url.endsWith("/api/claude/auto-continue")) return { enabled: JSON.parse(init.body).enabled };
    // The first read works; the one after saving the default fails.
    if (++reads > 1) throw new Error("Core is restarting");
    return current;
  });
  try {
    page.window.renderSetting({ detail, disabled: false });
    await tick();
    const select = page.document.querySelector('[aria-label="After Claude’s usage limit resets"]');
    assert.equal(select.selectedOptions[0].textContent, "Default · wait for you");
    button(page, "Make the default: continue").click();
    await tick();
    assert.equal(reads, 2);
    assert.equal(select.selectedOptions[0].textContent, "Default · continue", "the default Core confirmed");
    assert.ok(button(page, "Make the default: wait for you"), "the next choice follows the saved default");
    assert.match(page.document.querySelector('[role="alert"]').textContent, /^The default is saved, but this agent’s view couldn’t be read again/);
  } finally {
    page.close();
  }
});

test("the setting is this agent's choice or the workspace default", async () => {
  let current = view({ agent: null, enabled: false, intent: null, stopped: null });
  const page = mount((url, init) => {
    const body = init.body && JSON.parse(init.body);
    if (url.endsWith("/api/claude/auto-continue")) current = { ...current, workspace: body.enabled, enabled: current.agent ?? body.enabled };
    else if (init.method === "POST") current = { ...current, agent: body.enabled, enabled: body.enabled ?? current.workspace };
    return url.endsWith("/api/claude/auto-continue") ? { enabled: body.enabled } : current;
  });
  try {
    page.window.renderSetting({ detail, disabled: false });
    await tick();
    const select = page.document.querySelector('[aria-label="After Claude’s usage limit resets"]');
    assert.equal(select.value, "default");
    assert.equal(select.selectedOptions[0].textContent, "Default · wait for you", "off by default");
    Object.getOwnPropertyDescriptor(page.window.HTMLSelectElement.prototype, "value").set.call(select, "on");
    select.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await tick();
    assert.deepEqual(page.calls.at(-1).body, { enabled: true });
    assert.equal(select.value, "on");
    Object.getOwnPropertyDescriptor(page.window.HTMLSelectElement.prototype, "value").set.call(select, "default");
    select.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await tick();
    assert.deepEqual(page.calls.at(-1).body, { enabled: null }, "back to the default");
    button(page, "Make the default: continue").click();
    await tick();
    const set = page.calls.find((c) => c.url.endsWith("/api/claude/auto-continue") && c.method === "POST");
    assert.deepEqual(set.body, { enabled: true });
    assert.equal(select.selectedOptions[0].textContent, "Default · continue");
  } finally {
    page.close();
  }
});
