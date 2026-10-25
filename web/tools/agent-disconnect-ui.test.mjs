// Disconnect (T-184): the Agent menu offers it only for a connected, idle
// local Codex or Claude Agent; its confirmation says what stops and what
// stays, sends one request when confirmed and none when cancelled, and shows
// Core's refusal as it is. An Agent the user disconnected says so and offers
// Reconnect, which is one reconnect request; nothing else is sent. Fixture
// HTTP only; no Core.
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
const fixture = await mkdtemp(path.join(cache, "agent-disconnect-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {agentMenuItems} from ${src("agent-actions.ts")};
import {DisconnectAgentDialog} from ${src("DisconnectAgent.tsx")};
import {RecoveryNotice} from ${src("RecoveryNotice.tsx")};
const root = createRoot(document.getElementById('root'));
window.agentMenuItems = agentMenuItems;
window.done = [];
window.closed = 0;
window.renderDialog = agent => root.render(<DisconnectAgentDialog agent={agent} open
  onOpenChange={open => { if (!open) window.closed++; }} onDone={name => window.done.push(name)}/>);
window.renderNotice = detail => root.render(<RecoveryNotice detail={detail} disabled={false} hasDraft
  onRecovered={() => window.done.push('recovered')}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "AgentDisconnectUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
const agent = (id, rest = {}) => ({
  id, name: id.toUpperCase(), cwd: "/work", model: "m", color: "sage", harness: "codex",
  threadId: `thread-${id}`, status: "idle", connectionState: "connected",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, ...rest,
});

function mount(respond = () => ({})) {
  const calls = [];
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  window.fetch = async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    const { status = 200, body = {} } = await respond(url);
    const text = JSON.stringify(body);
    return { ok: status < 400, status, json: async () => body, text: async () => text };
  };
  window.eval(bundle);
  const document = window.document;
  const button = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
  return {
    window, document, calls, button,
    dialog: () => document.querySelector('[role="dialog"]'),
    alert: () => document.querySelector('[role="alert"]')?.textContent ?? null,
    close: () => window.close(),
  };
}
// Copied out of the page's realm: deepEqual compares prototypes.
const offered = (page, rest, options = { disconnect: true }) =>
  [...page.window.agentMenuItems(agent("a", rest), options)].some((item) => item.action === "disconnect");

test("Disconnect… is offered only for a connected, idle local Codex or Claude Agent, and only where the menu can run it", () => {
  const page = mount();
  assert.ok(offered(page, {}), "an idle connected Codex Agent");
  assert.ok(offered(page, { harness: "claude", threadId: undefined, claudeSessionId: "s" }), "an idle connected Claude Agent");
  const entry = [...page.window.agentMenuItems(agent("a"), { disconnect: true })].find((item) => item.action === "disconnect");
  assert.equal(entry.label, "Disconnect…");
  for (const [what, rest] of [
    ["working", { status: "working" }],
    ["waiting", { status: "waiting" }],
    ["uncertain", { status: "uncertain" }],
    ["offline", { status: "offline", connectionState: "disconnected" }],
    ["connecting", { connectionState: "connecting" }],
    ["closed", { closedAt: "now" }],
    ["already disconnected", { status: "offline", connectionState: "disconnected", disconnectedAt: "now" }],
    ["on an SSH machine", { remote: { machine: { id: "m", name: "Box" } } }],
    ["OpenCode", { harness: "opencode", threadId: undefined, opencodeSessionId: "s" }],
  ]) {
    assert.ok(!offered(page, rest), `not ${what}`);
  }
  assert.ok(!offered(page, {}, {}), "not where nothing handles it");
  page.close();
});

test("its confirmation says what stops and what stays; Cancel sends nothing; confirming sends one Disconnect", async () => {
  const page = mount((url) => (url.endsWith("/disconnect") ? { body: { agent: agent("a", { disconnectedAt: "now" }) } } : { status: 404 }));
  page.window.renderDialog(agent("a", { harness: "claude", threadId: undefined, claudeSessionId: "s" }));
  await tick();
  const text = page.dialog().textContent;
  assert.match(text, /Disconnect A\?/);
  assert.match(text, /stops the agent’s Claude Code session on this computer\. The agent stays open/);
  assert.match(text, /conversation, settings, permissions, tasks and your drafts are kept/);
  assert.match(text, /Jobs it started keep running/);
  assert.match(text, /nothing starts it again, not new mail, a message you send or automatic continue, until you press Reconnect/);
  assert.match(text, /To end the agent instead, use Close/);
  page.button("Cancel").click();
  await tick();
  assert.deepEqual(page.calls, [], "Cancel sent nothing");
  assert.equal(page.window.closed, 1);
  page.window.renderDialog(agent("a"));
  await tick();
  page.button("Disconnect").click();
  await tick();
  assert.deepEqual(page.calls, ["POST /api/agents/a/disconnect"]);
  assert.deepEqual([...page.window.done], ["A"]);
  page.close();
});

test("Core's refusal is shown as it is, nothing else is sent, and the dialog stays to read it", async () => {
  const refusal = "Not disconnected: 1 background terminal(s) are still running. Nothing changed.";
  const page = mount(() => ({ status: 400, body: { error: refusal } }));
  page.window.renderDialog(agent("a"));
  await tick();
  page.button("Disconnect").click();
  await tick();
  assert.equal(page.alert(), refusal);
  assert.deepEqual(page.calls, ["POST /api/agents/a/disconnect"]);
  assert.deepEqual([...page.window.done], [], "not called done");
  assert.ok(page.dialog(), "still open");
  page.close();
});

test("an Agent the user disconnected says so and offers Reconnect: one reconnect request, nothing sent", async () => {
  const page = mount((url) => (url.includes("/reconnect") ? { body: { agent: agent("a") } } : { status: 404 }));
  page.window.renderNotice({
    agent: agent("a", { status: "offline", connectionState: "disconnected", disconnectedAt: "2026-10-25T04:00:00Z" }),
    turns: [{ id: "t", status: "completed", items: [] }],
    pending: [],
  });
  await tick();
  const notice = page.document.querySelector(".recovery-notice").textContent;
  assert.match(notice, /You disconnected this agent on /);
  assert.match(notice, /Nothing starts it again, not new mail, a message or automatic continue, and messages for it wait/);
  assert.match(notice, /Your draft is kept/);
  page.button("Reconnect").click();
  await tick();
  assert.deepEqual(page.calls, ["POST /api/agents/a/reconnect?view=summary"]);
  assert.deepEqual([...page.window.done], ["recovered"]);
  page.close();
});
