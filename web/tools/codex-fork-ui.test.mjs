// Fork notice and dialog against fixture HTTP only; no Core, no Codex.
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
const fixture = await mkdtemp(path.join(cache, "codex-fork-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {CodexWriterNotice, ForkCodexDialog} from ${JSON.stringify(path.join(root, "src/ForkCodexSession.tsx"))};
const root = createRoot(document.getElementById('root'));
window.renderNotice = props => root.render(<CodexWriterNotice {...props}/>);
window.renderDialog = props => root.render(<ForkCodexDialog {...props}/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "ForkUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find(
    (item) => item.type === "chunk",
  ).code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const source = {
  id: "agent-a",
  name: "Yuzuno development",
  cwd: "/home/me/yuzuno-next",
  threadId: "019a1234-5678-4321-aaaa-123456789abc",
  connectionState: "disconnected",
};
const preview = {
  sourceThreadId: source.threadId,
  throughTurnId: "turn-12",
  throughCompletedAt: 1791856000,
  includedTurns: 12,
  excludedTurns: 1,
  name: source.name,
  cwd: source.cwd,
  model: "gpt-6-astra",
  reasoningEffort: "ultra",
  permissionPreset: "auto",
  projectId: "project-1",
  forkedTo: null,
  warnings: [],
};
const forkAgent = { ...source, id: "agent-b", threadId: "019a1234-5678-4321-bbbb-123456789abc" };

function mount(forkResponse, storage = {}) {
  const calls = [];
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  window.fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body && JSON.parse(init.body) });
    if (url.endsWith("/codex/fork/preview"))
      return { ok: true, status: 200, json: async () => preview, text: async () => JSON.stringify(preview) };
    const body = await forkResponse(calls.filter((c) => c.url.endsWith("/codex/fork")).length);
    // A network failure as the page sees it (an error from its own realm).
    if (body instanceof Error) throw new window.TypeError(body.message);
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  window.eval(bundle);
  return { window, document: window.document, calls, errors, close: () => window.close() };
}
const forks = (page) => page.calls.filter((c) => c.url.endsWith("/codex/fork"));
function button(page, label) {
  return [...page.document.querySelectorAll("button")].find((node) => node.textContent.trim() === label);
}
async function openDialog(page, events = {}, workspaceId = "ws-a") {
  page.window.renderDialog({
    agent: source,
    workspaceId,
    open: true,
    projectLabel: (id) => (id === "project-1" ? "Night work" : "Unknown"),
    onOpenChange: (open) => (events.open = open),
    onForked: (outcome) => (events.forked = outcome),
  });
  await tick();
  await tick();
  return events;
}

test("the notice explains another client's ownership and offers retry or fork", async () => {
  const page = mount(() => ({}));
  const events = [];
  const props = {
    agents: [source, forkAgent],
    disabled: false,
    onReconnect: async () => events.push("reconnect"),
    onFork: () => events.push("fork"),
    onOpen: (id) => events.push(`open:${id}`),
  };
  page.window.renderNotice({ ...props, detail: { agent: source, codexHandoff: { writerConflictAt: "now" } } });
  await tick();
  assert.match(page.document.body.textContent, /Another Codex client still owns this session/);
  button(page, "Try again").click();
  button(page, "Continue in a fork…").click();
  await tick();
  assert.deepEqual(events, ["reconnect", "fork"]);
  // Once continued elsewhere, the entry points there instead of offering a second fork.
  const continued = { agent: source, codexHandoff: { writerConflictAt: "now",
    forkedTo: { agentId: "agent-b", threadId: forkAgent.threadId, throughTurnId: "turn-12", turnCount: 12, at: "now" } } };
  page.window.renderNotice({ ...props, detail: continued });
  await tick();
  assert.match(page.document.body.textContent, /continues in Yuzuno development, from a Codex fork of its first 12 turns\. This session was not changed/);
  assert.ok(button(page, "Continue in a fork…") === undefined, 'no "Continue in a fork…" button');
  button(page, "Open").click();
  assert.equal(events.at(-1), "open:agent-b");
  // A closed continuation still exists and is still the place to go.
  page.window.renderNotice({ ...props, agents: [source, { ...forkAgent, closedAt: "later" }], detail: continued });
  await tick();
  assert.match(page.document.body.textContent, /continues in Yuzuno development \(closed\), from a Codex fork/);
  assert.ok(button(page, "Continue in a fork…") === undefined, 'no "Continue in a fork…" button');
  // A deleted one does not: the conflict and the explicit fork come back.
  page.window.renderNotice({ ...props, agents: [source], detail: continued });
  await tick();
  assert.match(page.document.body.textContent, /Another Codex client still owns this session/);
  assert.doesNotMatch(page.document.body.textContent, /continues in/);
  assert.ok(button(page, "Continue in a fork…"));
  // Connected, there is nothing to explain.
  page.window.renderNotice({ ...props, detail: { agent: { ...source, connectionState: "connected" }, codexHandoff: { writerConflictAt: "now" } } });
  await tick();
  assert.equal(page.document.body.textContent, "");
  page.close();
});

test("the dialog previews the boundary and kept settings; cancel writes nothing", async () => {
  const page = mount(() => ({}));
  const events = await openDialog(page);
  const text = page.document.body.textContent;
  // The copy is the whole prefix, which may hold interrupted or failed turns.
  assert.match(text, /Copies 12 turns/);
  assert.doesNotMatch(text, /completed turns/);
  assert.match(text, /1 later not included/);
  assert.match(text, /from this conversation’s history through its latest completed turn/);
  // Names the boundary the user is agreeing to.
  assert.ok(text.includes(`History up to and including the latest completed turn, completed ${new page.window.Date(1791856000 * 1000).toLocaleString()}.`));
  assert.match(text, /Later turns \(running, interrupted or failed\) stay with the original session/);
  assert.match(text, /gpt-6-astra · ultra reasoning · Approve for me · Night work/);
  assert.match(text, /This creates a new native session and a new agent/);
  assert.match(text, /The original session, its client and this entry stay open; nothing is closed for you/);
  assert.match(text, /copied to the new agent’s message box \(unless it already has one\); nothing is sent/);
  button(page, "Cancel").click();
  await tick();
  assert.equal(events.open, false);
  assert.equal(forks(page).length, 0);
  page.close();
});

test("one click forks once and hands the result over", async () => {
  const page = mount(() => ({ state: "completed", requestId: "r", agent: forkAgent, connected: true, message: null, warnings: [] }));
  const events = await openDialog(page);
  const fork = button(page, "Fork and continue");
  fork.click();
  fork.click();
  await tick();
  await tick();
  assert.equal(forks(page).length, 1);
  const body = forks(page)[0].body;
  assert.deepEqual(Object.keys(body).sort(), ["name", "requestId", "throughTurnId"]);
  assert.equal(body.throughTurnId, "turn-12");
  assert.equal(events.forked.agent.id, "agent-b");
  assert.equal(events.open, false);
  // A completed attempt leaves no request to resend.
  assert.equal(page.window.localStorage.getItem("yuzuno.codexForkRequests"), "{}");
  page.close();
});

test("a definite failure allows a fresh attempt; an unknown one forks again only by explicit choice", async () => {
  const page = mount((n) => n < 3
    ? { state: n === 1 ? "failed" : "uncertain", requestId: "unconfirmed-id", agent: null, connected: false,
        message: n === 1 ? "Codex 拒绝了 fork，原会话未改变" : "Codex 无法确认这次 fork 是否已创建，Yuzuno 不会自动重试。", warnings: [] }
    : { state: "completed", requestId: "new", agent: forkAgent, connected: true, message: null, warnings: [] });
  const events = await openDialog(page);
  button(page, "Fork and continue").click();
  await tick();
  await tick();
  assert.match(page.document.body.textContent, /The fork didn’t complete\. Codex 拒绝了 fork/);
  button(page, "Try again").click();
  await tick();
  await tick();
  assert.match(page.document.body.textContent, /The fork result isn’t confirmed yet\. Codex 无法确认/);
  assert.ok(button(page, "Check again") === undefined, 'no "Check again" button');
  button(page, "Fork again anyway").click();
  await tick();
  await tick();
  const [first, second, third] = forks(page).map((c) => c.body);
  assert.notEqual(first.requestId, second.requestId, "a failed attempt is never reused");
  assert.equal(second.abandonUnconfirmed, undefined, "nothing is abandoned without the explicit choice");
  assert.equal(third.abandonUnconfirmed, true);
  assert.notEqual(third.requestId, "unconfirmed-id");
  assert.equal(events.forked.agent.id, "agent-b");
  page.close();
});

test("a lost response keeps the request so the next click settles it", async () => {
  const page = mount((n) => (n === 1 ? new Error("Failed to fetch") : { state: "completed", requestId: "x", agent: forkAgent, connected: false, message: null, warnings: ["fork 已登记，但连接失败"] }));
  const events = await openDialog(page);
  button(page, "Fork and continue").click();
  await tick();
  await tick();
  // A lost answer reads as such; the browser's own text is kept out (T-170).
  assert.match(page.document.body.textContent, /No answer from Core over the network\./);
  assert.doesNotMatch(page.document.body.textContent, /Failed to fetch/);
  button(page, "Fork and continue").click();
  await tick();
  await tick();
  const [first, second] = forks(page).map((c) => c.body.requestId);
  assert.equal(first, second);
  assert.equal(events.forked.connected, false);
  page.close();
});

test("a lost fork's request is kept for its own Workspace only: the same Agent id elsewhere asks anew, and an older entry is never used (T-195)", async () => {
  const lost = () => new Error("Failed to fetch");
  const stored = (page) => JSON.parse(page.window.localStorage.getItem("yuzuno.codexForkRequests") || "{}");
  // In Workspace A the answer is lost: its request is kept.
  const a = mount(lost);
  await openDialog(a, {}, "ws-a");
  button(a, "Fork and continue").click();
  await tick();
  await tick();
  const first = forks(a)[0].body.requestId;
  const kept = stored(a);
  a.close();
  // The same address now answers as Workspace B, whose Agent has the same
  // id; an entry from before requests were kept per Workspace is there too.
  const older = `${source.id}:turn-12`;
  const b = mount(() => ({ state: "completed", requestId: "b", agent: forkAgent, connected: true, message: null, warnings: [] }), {
    "yuzuno.codexForkRequests": JSON.stringify({ ...kept, [older]: "older-request" }),
  });
  await openDialog(b, {}, "ws-b");
  button(b, "Fork and continue").click();
  await tick();
  await tick();
  const second = forks(b)[0].body.requestId;
  assert.notEqual(second, first, "B never retries A's attempt");
  assert.notEqual(second, "older-request", "an entry without a Workspace is never used");
  const after = stored(b);
  assert.equal(after[older], "older-request", "the older entry is left where it is");
  assert.equal(after[JSON.stringify(["ws-a", source.id, "turn-12"])], first, "A's attempt is still kept");
  b.close();
  // Back in A, the next click settles A's own attempt.
  const again = mount(() => ({ state: "completed", requestId: first, agent: forkAgent, connected: true, message: null, warnings: [] }), {
    "yuzuno.codexForkRequests": JSON.stringify(after),
  });
  await openDialog(again, {}, "ws-a");
  button(again, "Fork and continue").click();
  await tick();
  await tick();
  assert.equal(forks(again)[0].body.requestId, first);
  again.close();
});
