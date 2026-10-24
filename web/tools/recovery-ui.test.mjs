// Reconnect-and-check for an offline Agent whose last result is unconfirmed,
// against fixture HTTP only; no Core, no runtime.
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
const fixture = await mkdtemp(path.join(cache, "recovery-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {RecoveryNotice, recoveryReason} from ${JSON.stringify(path.join(root, "src/RecoveryNotice.tsx"))};
const root = createRoot(document.getElementById('root'));
window.recoveryReason = recoveryReason;
function NoticeFixture(props) {
  const [draft, setDraft] = React.useState('Keep this draft 文本');
  React.useEffect(() => { window.noticeReady = true; });
  return <><textarea aria-label="Draft" value={draft} onChange={e => setDraft(e.target.value)}/><RecoveryNotice {...props}/></>;
}
window.renderNotice = props => { window.noticeReady = false; root.render(<NoticeFixture {...props}/>); };`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "RecoveryUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
/** After a Core restart: offline, its last Turn still running locally. */
function detail(agent = {}, rest = {}) {
  return {
    agent: { id: "agent-a", name: "Dev", harness: "codex", status: "offline", connectionState: "disconnected",
      threadId: "019a1234-5678-4321-aaaa-123456789abc",
      error: "Workspace 服务已重启；上次执行是否完成尚未确认。", ...agent },
    turns: [{ id: "turn-1", status: "inProgress", items: [] }],
    pending: [],
    artifacts: [],
    ...rest,
  };
}

function mount(respond) {
  const calls = [];
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  window.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method });
    const { status = 200, body = {} } = await respond(calls.length);
    const text = JSON.stringify(body);
    return { ok: status < 400, status, json: async () => body, text: async () => text };
  };
  window.eval(bundle);
  return { window, document: window.document, calls, close: () => window.close() };
}
const button = (page) => page.document.querySelector(".recovery-notice button");
const text = (page) => page.document.body.textContent;

test("it is offered where reconnecting can check a result or open an offline session", () => {
  const page = mount(() => ({}));
  const reason = (d) => page.window.recoveryReason(d);
  assert.equal(reason(detail()), "running");
  assert.equal(reason(detail({ harness: "claude", threadId: undefined, claudeSessionId: "0b5c8f9e-0000-4000-8000-000000000001" })), "running");
  assert.equal(reason(detail({ status: "uncertain" }, { turns: [{ id: "t", status: "interrupted", items: [] }] })), "uncertain");
  // Offline, its last Turn ended: nothing to check, but the session can be
  // opened again without a message (T-184); also while Core is connecting.
  const ended = { turns: [{ id: "t", status: "completed", items: [] }] };
  assert.equal(reason(detail({}, ended)), "offline");
  assert.equal(reason(detail({ connectionState: "connecting" }, ended)), "offline");
  assert.equal(reason(detail({ connectionState: undefined, status: "offline" }, ended)), "offline");
  // An older Core that reports no connection: not offline unless it says so.
  assert.equal(reason(detail({ connectionState: undefined, status: "idle" }, ended)), null);
  assert.equal(reason(detail({ connectionState: "connected", status: "idle" }, ended)), null);
  // Connected: the running Turn is real.
  assert.equal(reason(detail({ connectionState: "connected", status: "working" })), null);
  assert.equal(reason(detail({ connectionState: "connected", status: "uncertain" })), "uncertain");
  assert.equal(reason(detail({ connectionState: "unconfirmed", status: "error" })), "uncertain");
  // Closed, or no session to reconnect to: no misleading action.
  assert.equal(reason(detail({ closedAt: "now" })), null);
  assert.equal(reason(detail({ closedAt: "now" }, ended)), null);
  assert.equal(reason(detail({ threadId: undefined }, ended)), null);
  assert.equal(reason(detail({ remote: { machine: { id: "m", name: "Box" } } }, ended)), null);
  assert.equal(reason(detail({ threadId: undefined })), null);
  assert.equal(reason(detail({ harness: "claude", threadId: undefined })), null);
  // Other notices already offer a reconnect; the remote controls do too.
  assert.equal(reason(detail({}, { codexHandoff: { writerConflictAt: "now" } })), null);
  assert.equal(reason(detail({}, { messageReceipts: [{ status: "uncertain", input: { clientMessageId: "m", text: "x" } }] })), null);
  assert.equal(reason(detail({ remote: { machine: { id: "m", name: "Box" } } })), null);
  page.close();
});

test("one click sends one reconnect, shows it working, and lets Core decide", async () => {
  const waitFor = async (ready) => {
    for (let attempt = 0; attempt < 80 && !ready(); attempt++) await tick();
    assert.ok(ready(), "the fixture completed its pending React work");
  };
  let release;
  const page = mount(() => new Promise((resolve) => { release = () => resolve({ body: {} }); }));
  let recovered = 0;
  page.window.renderNotice({ detail: detail(), disabled: false, hasDraft: true, onRecovered: () => recovered++ });
  // Child mount effects run before this parent's readiness effect.
  await waitFor(() => page.window.noticeReady);
  assert.match(text(page), /still running when this agent’s connection ended/);
  assert.match(text(page), /nothing is sent again\. Your draft is kept\./);
  assert.equal(button(page).textContent.trim(), "Reconnect and check");
  button(page).click();
  button(page).click();
  await waitFor(() => button(page).textContent.trim() === "Reconnecting…" && button(page).disabled);
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].url, "/api/agents/agent-a/reconnect?view=summary");
  assert.equal(page.calls[0].method, "POST");
  assert.equal(button(page).textContent.trim(), "Reconnecting…");
  assert.equal(button(page).disabled, true);
  assert.equal(recovered, 0);
  release();
  await waitFor(() => recovered === 1 && !button(page).disabled);
  // The refreshed detail, not this click, decides whether input unlocks.
  assert.equal(recovered, 1);
  assert.equal(button(page).disabled, false);
  page.close();
});

test("collaboration recovery remains available for a connected working remote without changing its native state", async () => {
  const page = mount(() => ({}));
  const d = detail({ status: "working", connectionState: "connected", remote: { machine: { id: "m" } } },
    { collaboration: { ready: false, reason: "unsupported", error: "The native runtime cannot check Workspace MCP. Reconnect, or close and reopen once its turn ends." } });
  assert.equal(page.window.recoveryReason(d), "collaboration");
  assert.equal(page.window.recoveryReason({ ...d, collaboration: { ready: true } }), null);
  assert.equal(page.window.recoveryReason({ ...d, agent: { ...d.agent, closedAt: "now" } }), null);
  let refreshed = 0;
  page.window.renderNotice({ detail: d, disabled: false, hasDraft: true, onRecovered: () => refreshed++ });
  await tick();
  assert.match(text(page), /native runtime cannot check Workspace MCP/);
  assert.match(text(page), /Your draft is kept/);
  button(page).click();
  await tick();
  await tick();
  assert.equal(refreshed, 1);
  assert.deepEqual(page.calls, [{ url: "/api/agents/agent-a/reconnect?view=summary", method: "POST" }]);
  assert.equal(page.window.recoveryReason(d), "collaboration");
  assert.equal(d.agent.status, "working");
  page.close();
});

test("an older Core's whole record in the reconnect answer is not read", async () => {
  // A Core from before view=summary sends the whole record back; the notice
  // reads none of it, and the refreshed detail decides as before.
  const old = detail({ status: "idle", connectionState: "connected", error: null, name: "From the answer" },
    { turns: [{ id: "turn-other", status: "completed", items: [] }] });
  const page = mount(() => ({ body: old }));
  let recovered = 0;
  const shown = detail();
  page.window.renderNotice({ detail: shown, disabled: false, hasDraft: true, onRecovered: () => recovered++ });
  await tick();
  button(page).click();
  await tick();
  await tick();
  assert.equal(recovered, 1);
  assert.deepEqual(page.calls, [{ url: "/api/agents/agent-a/reconnect?view=summary", method: "POST" }]);
  assert.match(text(page), /still running when this agent’s connection ended/, "still what the shown detail says");
  assert.equal(shown.turns[0].id, "turn-1");
  page.close();
});

test("a failed reconnect says why and can be tried again", async () => {
  const page = mount((n) => (n === 1
    ? { status: 400, body: { error: "Could not start Codex: install the official Codex CLI on the Core host and sign in to it" } }
    : { body: {} }));
  let recovered = 0;
  page.window.renderNotice({ detail: detail({ status: "uncertain" }, { turns: [] }), disabled: false, hasDraft: false, onRecovered: () => recovered++ });
  await tick();
  assert.match(text(page), /previous result isn’t confirmed yet/);
  assert.doesNotMatch(page.document.querySelector(".recovery-notice").textContent, /draft/);
  button(page).click();
  await tick();
  await tick();
  assert.match(page.document.querySelector("[role=alert]").textContent, /Couldn’t reconnect: Could not start Codex: install the official Codex CLI/);
  assert.equal(button(page).textContent.trim(), "Try again");
  button(page).click();
  await tick();
  await tick();
  assert.equal(page.calls.length, 2);
  assert.ok(page.document.querySelector("[role=alert]") === null, "[role=alert] is absent");
  assert.equal(recovered, 2);
  page.close();
});

test("it waits while Core is already connecting, and is inert when disabled", async () => {
  const page = mount(() => ({}));
  page.window.renderNotice({ detail: detail({ connectionState: "connecting" }), disabled: false, hasDraft: false, onRecovered() {} });
  await tick();
  assert.equal(button(page).disabled, true);
  assert.equal(button(page).textContent.trim(), "Reconnecting…");
  page.window.renderNotice({ detail: detail(), disabled: true, hasDraft: false, onRecovered() {} });
  await tick();
  button(page).click();
  await tick();
  assert.equal(page.calls.length, 0);
  page.close();
});

test("a native timeout refreshes to unconfirmed and leaves the same-session check enabled", async () => {
  const page = mount(() => ({ status: 400, body: { error: "Native resume timed out; its result is unknown" } }));
  const props = { detail: detail({ connectionState: "connecting" }), disabled: false, hasDraft: true,
    onRecovered() {
      page.window.renderNotice({ ...props, detail: detail({ connectionState: "unconfirmed", status: "uncertain" }) });
    } };
  // Core was connecting on the first load; a fresh detail after timeout unlocks
  // checking, without interpreting the unknown outcome as successful recovery.
  page.window.renderNotice(props);
  await tick();
  assert.equal(button(page).disabled, true);
  page.window.renderNotice({ ...props, detail: detail({ connectionState: "unconfirmed", status: "uncertain" }) });
  await tick();
  assert.equal(button(page).disabled, false);
  button(page).click();
  await tick(); await tick();
  assert.equal(button(page).disabled, false);
  assert.equal(button(page).textContent.trim(), "Try again");
  assert.match(text(page), /result is unknown/);
  assert.match(text(page), /Your draft is kept/);
  button(page).click();
  await tick(); await tick();
  assert.equal(page.calls.length, 2);
  assert.ok(page.calls.every(c => c.url === "/api/agents/agent-a/reconnect?view=summary"));
  assert.equal(page.document.querySelector('textarea').value, "Keep this draft 文本");
  page.close();
});

test("an offline session is reconnected by one click without a message, and Core says what it is doing (T-184)", async () => {
  const waitFor = async (ready) => {
    for (let attempt = 0; attempt < 80 && !ready(); attempt++) await tick();
    assert.ok(ready(), "the fixture completed its pending React work");
  };
  let release;
  const page = mount(() => new Promise((resolve) => { release = () => resolve({ body: {} }); }));
  let recovered = 0;
  const ended = { turns: [{ id: "turn-1", status: "completed", items: [] }] };
  page.window.renderNotice({ detail: detail({}, ended), disabled: false, hasDraft: true, onRecovered: () => recovered++ });
  await waitFor(() => page.window.noticeReady);
  assert.match(text(page), /This agent’s session isn’t connected\. Reconnect to open the same session; nothing is sent\. Your draft is kept\./);
  assert.doesNotMatch(text(page), /isn’t confirmed/);
  assert.equal(button(page).textContent.trim(), "Reconnect");
  button(page).click();
  button(page).click();
  await waitFor(() => button(page).disabled);
  assert.equal(button(page).textContent.trim(), "Reconnecting…");
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].url, "/api/agents/agent-a/reconnect?view=summary");
  assert.equal(page.calls[0].method, "POST");
  release();
  await waitFor(() => recovered === 1 && !button(page).disabled);
  // What it is doing now comes from Core's refreshed record, not this click.
  page.window.renderNotice({ detail: detail({ connectionState: "connected", status: "idle" }, ended), disabled: false, hasDraft: true, onRecovered: () => recovered++ });
  await tick();
  assert.ok(page.document.querySelector(".recovery-notice") === null, "a connected Agent shows no notice");
  assert.equal(page.calls.length, 1);
  assert.ok(page.calls.every((c) => !c.url.includes("/messages")), "no message was sent");
  assert.equal(page.document.querySelector("textarea").value, "Keep this draft 文本");
  page.close();
});
