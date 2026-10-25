// Reconnecting several Agents at once (T-184): who is listed, that nothing
// is chosen for the user, at most three requests at once, what each row
// says, retry, scope, and that only the existing reconnect is sent. Fixture
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
const fixture = await mkdtemp(path.join(cache, "batch-reconnect-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {BatchReconnect} from ${src("BatchReconnect.tsx")};
import {BATCH_LIMIT} from ${src("batch-reconnect.ts")};
import {reconnectAgent} from ${src("api.ts")};
const root = createRoot(document.getElementById('root'));
window.BATCH_LIMIT = BATCH_LIMIT;
window.reconnectAgent = reconnectAgent;
window.settled = 0;
window.interrupts = 0;
// As App's window listener does: Escape interrupts unless a dialog took it.
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[role="dialog"]')) window.interrupts++;
});
window.render = (agents, scope = 'all', workspace = 'w') => root.render(<div className="rail-heading"><BatchReconnect workspaceId={workspace}
  agents={agents} scope={scope} onSettled={() => window.settled++}/></div>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "BatchReconnectUI", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
const agent = (id, rest = {}) => ({
  id, name: id.toUpperCase(), cwd: "/work", model: "m", color: "sage", harness: "codex",
  threadId: `thread-${id}`, status: "offline", connectionState: "disconnected",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0, ...rest,
});
const connected = (a, status = "idle") => ({ agent: { ...a, status, connectionState: "connected" } });

// Every request waits until the test answers it.
function mount() {
  const calls = [];
  const flight = { now: 0, most: 0 };
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  window.fetch = (url, init = {}) =>
    new Promise((resolve) => {
      flight.now++;
      flight.most = Math.max(flight.most, flight.now);
      calls.push({
        url, method: init.method,
        answer: ({ status = 200, body = {} } = {}) => {
          flight.now--;
          resolve({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
        },
      });
    });
  window.eval(bundle);
  const document = window.document;
  const row = (name) => [...document.querySelectorAll(".batch-row")].find((r) => r.querySelector(".batch-name").textContent === name);
  return {
    window, document, calls, flight,
    trigger: () => document.querySelector(".rail-reconnect"),
    rows: () => [...document.querySelectorAll(".batch-row")].map((r) => {
      const box = r.querySelector("input");
      return `${r.querySelector(".batch-name").textContent} ${box.disabled ? "-" : box.checked ? "[x]" : "[ ]"} ${r.querySelector(".batch-state").textContent}`;
    }),
    row,
    toggle: (name) => row(name).querySelector("input").click(),
    retry: (name) => [...row(name).querySelectorAll("button")].find((b) => b.textContent === "Retry").click(),
    primary: () => document.querySelector(".modal-actions .primary-button"),
    summary: () => document.querySelector(".batch-summary[role=status]").textContent,
    note: () => document.querySelector(".batch-note")?.textContent ?? null,
    secondary: () => document.querySelector(".modal-actions .secondary-button"),
    dialog: () => document.querySelector('[role="dialog"]'),
    // Only the existing reconnect, never a message, a reopen or an interrupt.
    sent: () => calls.map((c) => `${c.method} ${c.url}`),
    close: () => window.close(),
  };
}
const reconnectUrl = (id) => `POST /api/agents/${id}/reconnect?view=summary`;

test("it lists only Agents that can be reconnected, chooses none of them, and is hidden when none can", async () => {
  const page = mount();
  page.window.render([
    agent("a"),
    agent("b", { status: "uncertain", connectionState: "unconfirmed" }),
    agent("c", { connectionState: "connecting" }),
    agent("d", { closedAt: "2026-10-20" }),
    agent("e", { threadId: undefined }),
    agent("f", { status: "idle", connectionState: "connected" }),
  ]);
  await tick();
  assert.equal(page.trigger().getAttribute("aria-label"), "Reconnect agents: 2 not connected");
  page.trigger().click();
  await tick();
  assert.ok(page.dialog(), "it opened");
  // Closed (d), no session (e) and connected (f) are not listed; Core is
  // already connecting c, which shows but can't be chosen.
  assert.deepEqual(page.rows(), ["A [ ] Offline", "B [ ] Result unconfirmed", "C - Reconnecting…"]);
  assert.equal(page.primary().disabled, true, "nothing chosen, nothing to run");
  assert.equal(page.primary().textContent, "Reconnect");
  assert.equal(page.secondary().textContent, "Select all");
  page.window.render([agent("f", { status: "idle", connectionState: "connected" })]);
  await tick();
  page.document.querySelector('[aria-label="Close dialog"]').click();
  await tick();
  assert.equal(page.trigger(), null, "no button while every Agent is connected");
  assert.deepEqual(page.sent(), []);
  page.close();
});

test("one whose stop its SSH machine didn't confirm says so, and is left out of Select all too (T-184)", async () => {
  const page = mount();
  page.window.render([agent("a"), agent("b", { disconnectedAt: "2026-10-25T04:00:00Z", disconnectUnconfirmed: true })]);
  await tick();
  page.trigger().click();
  await tick();
  const row = "B [ ] Disconnected by you, stop not confirmed; nothing starts it automatically. Tick it to reconnect it";
  assert.deepEqual(page.rows(), ["A [ ] Offline", row]);
  page.secondary().click();
  await tick();
  assert.deepEqual(page.rows(), ["A [x] Offline", row], "Select all leaves it out");
  assert.deepEqual(page.sent(), []);
  page.close();
});

test("an Agent the user disconnected is listed but left out of Select all; ticked, it is reconnected too (T-184)", async () => {
  const page = mount();
  page.window.render([agent("a"), agent("b", { disconnectedAt: "2026-10-25T04:00:00Z" })]);
  await tick();
  page.trigger().click();
  await tick();
  assert.deepEqual(page.rows(), ["A [ ] Offline", "B [ ] Disconnected by you; tick it to reconnect it"]);
  page.secondary().click();
  await tick();
  assert.deepEqual(page.rows(), ["A [x] Offline", "B [ ] Disconnected by you; tick it to reconnect it"], "Select all leaves it out");
  assert.equal(page.secondary().textContent, "Clear");
  page.toggle("B");
  await tick();
  assert.deepEqual(page.rows(), ["A [x] Offline", "B [x] Disconnected by you; tick it to reconnect it"], "the user can choose it");
  assert.equal(page.secondary().textContent, "Clear");
  page.secondary().click();
  await tick();
  assert.deepEqual(page.rows(), ["A [ ] Offline", "B [ ] Disconnected by you; tick it to reconnect it"], "Clear unchooses the one ticked by hand too");
  page.toggle("B");
  page.secondary().click();
  await tick();
  assert.deepEqual(page.rows(), ["A [x] Offline", "B [x] Disconnected by you; tick it to reconnect it"]);
  page.primary().click();
  await tick();
  assert.deepEqual(page.sent().sort(), [reconnectUrl("a"), reconnectUrl("b")].sort());
  for (const call of page.calls) call.answer({ body: connected(agent(call.url.includes("/a/") ? "a" : "b")) });
  await tick();
  page.close();
});

test("at most three run at once; each row says what Core answered; a failure stays chosen and can be retried", async () => {
  const page = mount();
  const five = ["a", "b", "c", "d", "e"].map((id) => agent(id));
  page.window.render(five);
  await tick();
  page.trigger().click();
  await tick();
  page.secondary().click();
  await tick();
  assert.equal(page.primary().textContent, "Reconnect 5");
  page.primary().click();
  await tick();
  assert.equal(page.window.BATCH_LIMIT, 3);
  assert.deepEqual(page.sent(), ["a", "b", "c"].map(reconnectUrl), "three at once");
  assert.deepEqual(page.rows(), ["A - Reconnecting…", "B - Reconnecting…", "C - Reconnecting…", "D - Waiting…", "E - Waiting…"]);
  page.calls[0].answer({ body: connected(five[0]) });
  await tick();
  assert.equal(page.calls.length, 4, "the next starts when one ends");
  page.calls[1].answer({ status: 400, body: { error: "Could not start Codex" } });
  await tick();
  page.calls[2].answer({ body: { agent: { ...five[2], status: "uncertain", connectionState: "unconfirmed" } } });
  await tick();
  page.calls[3].answer({ body: connected(five[3], "working") });
  await tick();
  page.calls[4].answer({ body: { agent: five[4] } });
  await tick();
  assert.equal(page.flight.most, 3, "never more than three in flight");
  // Each says what Core reported: nothing is called Ready before it says so.
  // What still needs a reconnect, and a failure, stay chosen for another try.
  assert.deepEqual(page.rows(), [
    "A [ ] Connected · Ready",
    "B [x] Couldn’t reconnect: Could not start Codex",
    "C [x] Result unconfirmed",
    "D [ ] Connected · Working",
    "E [x] Still offline",
  ]);
  assert.equal(page.window.settled, 5, "the Workspace is read again after each");
  assert.equal(page.summary(), "2 reconnected · 2 not connected yet · 1 couldn’t reconnect");
  assert.equal(page.primary().textContent, "Reconnect 3");
  page.retry("B");
  await tick();
  assert.equal(page.calls.length, 6);
  assert.equal(page.sent().at(-1), reconnectUrl("b"));
  page.calls[5].answer({ body: connected(five[1]) });
  await tick();
  assert.equal(page.rows()[1], "B [ ] Connected · Ready");
  assert.equal(page.summary(), "3 reconnected · 2 not connected yet");
  assert.ok(page.sent().every((s) => /^POST \/api\/agents\/[a-e]\/reconnect\?view=summary$/.test(s)), "only the reconnect was sent");
  page.close();
});

test("closing keeps the selection and failures, not answers already read; Escape closes it and interrupts nothing", async () => {
  const page = mount();
  page.window.render([agent("a"), agent("b")]);
  await tick();
  page.trigger().click();
  await tick();
  page.toggle("A");
  page.toggle("B");
  await tick();
  page.primary().click();
  await tick();
  page.calls[0].answer({ body: connected(agent("a")) });
  page.calls[1].answer({ status: 503, body: { error: "Runtime not ready" } });
  await tick();
  page.document.activeElement.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await tick();
  assert.equal(page.dialog(), null, "Escape closed it");
  assert.equal(page.window.interrupts, 0, "the window's Escape did not interrupt");
  // As the Workspace reads after the reconnects: A connected, B not.
  page.window.render([agent("a", { status: "idle", connectionState: "connected" }), agent("b")]);
  await tick();
  page.trigger().click();
  await tick();
  assert.deepEqual(page.rows(), ["B [x] Couldn’t reconnect: Runtime not ready"]);
  assert.equal(page.primary().textContent, "Reconnect 1");
  page.close();
});

test("a reconnect already on its way from another control is not sent again", async () => {
  const page = mount();
  const a = agent("a");
  page.window.render([a]);
  await tick();
  void page.window.reconnectAgent("a"); // as from its menu or notice
  page.trigger().click();
  await tick();
  page.toggle("A");
  await tick();
  page.primary().click();
  await tick();
  assert.deepEqual(page.sent(), [reconnectUrl("a")], "one request for both");
  page.calls[0].answer({ body: connected(a) });
  await tick();
  assert.deepEqual(page.rows(), ["A [ ] Connected · Ready"]);
  page.close();
});

test("in a project it lists that project's Agents; others only when asked; a choice hidden by the scope does not run", async () => {
  const page = mount();
  page.window.render([agent("a", { projectId: "p1" }), agent("b", { projectId: "p2" }), agent("c", { projectId: "p1" })], "project:p1");
  await tick();
  page.trigger().click();
  await tick();
  assert.deepEqual(page.rows(), ["A [ ] Offline", "C [ ] Offline"]);
  const others = page.document.querySelector(".batch-scope input");
  assert.equal(page.document.querySelector(".batch-scope").textContent, "Include other projects (1)");
  others.click();
  await tick();
  assert.deepEqual(page.rows(), ["A [ ] Offline", "B [ ] Offline", "C [ ] Offline"]);
  page.toggle("B");
  await tick();
  others.click();
  await tick();
  assert.equal(page.primary().disabled, true, "B is chosen but not shown, so it does not run");
  page.secondary().click();
  await tick();
  page.primary().click();
  await tick();
  assert.deepEqual(page.sent(), [reconnectUrl("a"), reconnectUrl("c")]);
  page.close();
});

test("a failure reconnected elsewhere since is not shown again, and its choice is dropped", async () => {
  const page = mount();
  page.window.render([agent("a"), agent("b")]);
  await tick();
  page.trigger().click();
  await tick();
  page.toggle("B");
  await tick();
  page.primary().click();
  await tick();
  page.calls[0].answer({ status: 503, body: { error: "Runtime not ready" } });
  await tick();
  assert.deepEqual(page.rows(), ["A [ ] Offline", "B [x] Couldn’t reconnect: Runtime not ready"]);
  page.document.querySelector('[aria-label="Close dialog"]').click();
  await tick();
  // B is reconnected from its own menu meanwhile.
  page.window.render([agent("a"), agent("b", { status: "idle", connectionState: "connected" })]);
  await tick();
  page.trigger().click();
  await tick();
  assert.deepEqual(page.rows(), ["A [ ] Offline"], "B's old failure is not shown");
  page.document.querySelector('[aria-label="Close dialog"]').click();
  await tick();
  // Offline again later: nothing chosen for the user.
  page.window.render([agent("a"), agent("b")]);
  await tick();
  page.trigger().click();
  await tick();
  assert.deepEqual(page.rows(), ["A [ ] Offline", "B [ ] Offline"]);
  assert.equal(page.calls.length, 1);
  page.close();
});

test("each queued Agent is checked again before it is sent: closed, on another session or connected since, it is skipped and said so", async () => {
  const page = mount();
  const six = ["a", "b", "c", "d", "e", "f"].map((id) => agent(id));
  page.window.render(six);
  await tick();
  page.trigger().click();
  await tick();
  page.secondary().click();
  await tick();
  page.primary().click();
  await tick();
  assert.deepEqual(page.sent(), ["a", "b", "c"].map(reconnectUrl));
  // While D, E and F wait their turn: D is closed, E is on a new session,
  // F is connected from its own menu.
  page.window.render([
    ...six.slice(0, 3),
    agent("d", { closedAt: "2026-10-24" }),
    agent("e", { threadId: "thread-e-2" }),
    agent("f", { status: "idle", connectionState: "connected" }),
  ]);
  await tick();
  for (const call of page.calls.slice(0, 3)) call.answer({ body: connected(six[page.calls.indexOf(call)]) });
  await tick();
  assert.deepEqual(page.sent(), ["a", "b", "c"].map(reconnectUrl), "nothing sent for D, E or F");
  assert.deepEqual(page.rows().slice(3), [
    "D - Skipped: closed since, and not reopened here",
    "E [ ] Skipped: its session changed; choose it again",
    "F - Skipped: already connected",
  ], "skipped, said so, and not chosen again");
  assert.equal(page.summary(), "3 reconnected · 3 skipped");
  assert.equal(page.window.settled, 3, "read again after each request only");
  // Read once: closing lets the skips go. Closed D and connected F are not
  // listed again, and E reads as it is now.
  page.document.querySelector('[aria-label="Close dialog"]').click();
  await tick();
  page.trigger().click();
  await tick();
  assert.deepEqual(page.rows(), ["A [ ] Offline", "B [ ] Offline", "C [ ] Offline", "E [ ] Offline"]);
  assert.equal(page.summary(), "");
  page.close();
});

test("while a batch runs its button and results stay, even with nothing else to reconnect; closing says it cancels nothing", async () => {
  const page = mount();
  const a = agent("a");
  page.window.render([a]);
  await tick();
  page.trigger().click();
  await tick();
  assert.equal(page.note(), null, "nothing running, nothing to say");
  page.toggle("A");
  await tick();
  page.primary().click();
  await tick();
  assert.equal(page.note(), "Closing this doesn’t cancel anything: reconnects already started or queued go on, and their results stay here.");
  page.document.querySelector('[aria-label="Close dialog"]').click();
  await tick();
  // Core already lists it as connecting: none left to choose, the batch runs on.
  page.window.render([agent("a", { connectionState: "connecting" })]);
  await tick();
  assert.equal(page.trigger()?.getAttribute("aria-label"), "Reconnect agents: reconnecting", "the button stays while it runs");
  page.trigger().click();
  await tick();
  assert.deepEqual(page.rows(), ["A - Reconnecting…"]);
  page.calls[0].answer({ body: connected(a) });
  await tick();
  page.window.render([agent("a", { status: "idle", connectionState: "connected" })]);
  await tick();
  assert.deepEqual(page.rows(), ["A - Connected · Ready"], "its result stays while the dialog is open");
  page.document.querySelector('[aria-label="Close dialog"]').click();
  await tick();
  assert.equal(page.trigger(), null, "done, and nothing left: no button");
  page.close();
});

test("each Workspace keeps its own batch", async () => {
  const page = mount();
  page.window.render([agent("a")], "all", "w");
  await tick();
  page.trigger().click();
  await tick();
  page.toggle("A");
  await tick();
  page.primary().click();
  await tick();
  page.calls[0].answer({ status: 503, body: { error: "Runtime not ready" } });
  await tick();
  page.document.querySelector('[aria-label="Close dialog"]').click();
  await tick();
  // Another Workspace, whose Agent "a" is another Agent with the same ID.
  page.window.render([agent("a", { name: "Elsewhere" })], "all", "v");
  await tick();
  page.trigger().click();
  await tick();
  assert.deepEqual(page.rows(), ["Elsewhere [ ] Offline"], "no choice or failure from the other Workspace");
  page.document.querySelector('[aria-label="Close dialog"]').click();
  await tick();
  page.window.render([agent("a")], "all", "w");
  await tick();
  page.trigger().click();
  await tick();
  assert.deepEqual(page.rows(), ["A [x] Couldn’t reconnect: Runtime not ready"], "its own are still there");
  page.close();
});
