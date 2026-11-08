// An Agent's action menu (T-184): what it offers by state, how it opens (its
// "…" button, a right-click, a long-press) and closes, and that every entry
// acts once on the Agent it was opened on. Fixture HTTP only; no Core.
import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";
import { openTip, tipLines } from "./tip-dom.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "agent-actions-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {createRoot} from 'react-dom/client';
import {AgentRailRow, LONG_PRESS_MS} from ${src("AgentRailRow.tsx")};
import {AgentActionsMenu} from ${src("AgentActionsMenu.tsx")};
import {agentMenuItems} from ${src("agent-actions.ts")};
import {interruptAgent, reconnectAgent} from ${src("api.ts")};
const root = createRoot(document.getElementById('root'));
window.agentMenuItems = agentMenuItems;
window.LONG_PRESS_MS = LONG_PRESS_MS;
window.opened = [];
window.done = [];
window.failed = [];
window.interrupts = 0;
// As App's window listener does: Escape interrupts unless something took it.
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !event.defaultPrevented) window.interrupts++;
});
// As App's handlers do, by the Agent ID the menu gives.
const handlers = {
  reconnect: id => reconnectAgent(id)
    .then(() => window.done.push('reconnected:' + id), e => window.failed.push(id + ': ' + e.message)),
  interrupt: id => interruptAgent(id)
    .then(() => window.done.push('interrupted:' + id), e => window.failed.push(id + ': ' + e.message)),
  settings: id => window.done.push('settings:' + id),
  manage: id => window.done.push('manage:' + id),
};
window.renderRows = agents => root.render(<>{agents.map(a =>
  <AgentRailRow key={a.id} agent={a} selected={false} statusLabel={a.status}
    onSelect={() => window.opened.push(a.id)} actions={handlers}/>)}</>);
window.renderHeader = agent => root.render(<AgentActionsMenu agent={agent} handlers={handlers} label="Conversation actions"/>);`,
  );
  const result = await build({
    root,
    configFile: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
    plugins: [react()],
    build: { write: false, lib: { entry, name: "AgentActionsUI", formats: ["iife"] } },
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
    calls.push({ url, method: init.method });
    const { status = 200, body = {} } = await respond(url, calls.length);
    const text = JSON.stringify(body);
    return { ok: status < 400, status, json: async () => body, text: async () => text };
  };
  window.eval(bundle);
  const document = window.document;
  return {
    window, document, calls,
    menu: () => document.querySelector('[role="menu"]'),
    item: (action) => document.querySelector(`[role="menuitem"][data-action="${action}"]`),
    row: (id) => document.querySelector(`.agent-row[data-agent-id="${id}"]`),
    key: (target, key) => target.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
    pointer: (target, type, init) => target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, pointerId: 7, ...init })),
    close: () => window.close(),
  };
}
// Copied out of the page's realm: deepEqual compares prototypes.
const actions = (items) => [...items].map((item) => `${item.action}${item.disabled ? " (disabled)" : ""}:${item.label}`);

test("it offers only what applies to the Agent as it is", () => {
  const page = mount();
  const menu = (rest) => actions(page.window.agentMenuItems(agent("a", rest)));
  assert.deepEqual(menu({}), ["settings:Agent settings…", "manage:Manage…"]);
  assert.deepEqual(menu({ status: "offline", connectionState: "disconnected" }),
    ["reconnect:Reconnect", "settings:Agent settings…", "manage:Manage…"]);
  assert.deepEqual(menu({ status: "uncertain", connectionState: "unconfirmed" }),
    ["check:Reconnect and check", "settings:Agent settings…", "manage:Manage…"]);
  assert.deepEqual(menu({ status: "offline", connectionState: "connecting" }),
    ["reconnect (disabled):Reconnecting…", "settings:Agent settings…", "manage:Manage…"]);
  assert.deepEqual(menu({ status: "working" }), ["interrupt:Interrupt current turn", "settings:Agent settings…", "manage:Manage…"]);
  assert.deepEqual(menu({ status: "waiting" }), ["interrupt:Interrupt current turn", "settings:Agent settings…", "manage:Manage…"]);
  // Closed: it reopens from Manage, never reconnects or interrupts here.
  assert.deepEqual(menu({ status: "offline", connectionState: "disconnected", closedAt: "now" }), ["manage:Manage…"]);
  // No session to reconnect to; OpenCode's Agent settings choose its model (T-10).
  assert.deepEqual(menu({ status: "offline", connectionState: "disconnected", threadId: undefined }), ["settings:Agent settings…", "manage:Manage…"]);
  assert.deepEqual(menu({ harness: "opencode", opencodeSessionId: "s", threadId: undefined }), ["settings:Agent settings…", "manage:Manage…"]);
  // A remote Agent reconnects through the same request.
  assert.deepEqual(menu({ status: "offline", connectionState: "disconnected", threadId: undefined, remote: { machine: { id: "m", name: "Box" } } }),
    ["reconnect:Reconnect", "settings:Agent settings…", "manage:Manage…"]);
  page.close();
});

test("Copy agent link is offered for any Agent, closed or without a Turn, where the menu can copy it (T-184)", () => {
  const page = mount();
  const offered = (rest, options = { link: true }) =>
    actions(page.window.agentMenuItems(agent("a", rest), options)).filter((item) => item.startsWith("copyLink"));
  for (const rest of [
    {},
    { threadId: undefined },
    { status: "working" },
    { status: "offline", connectionState: "disconnected", closedAt: "now" },
    { harness: "opencode", opencodeSessionId: "s", threadId: undefined },
    { remote: { machine: { id: "m", name: "Box" } } },
  ]) assert.deepEqual(offered(rest), ["copyLink:Copy agent link"], JSON.stringify(rest));
  assert.deepEqual(offered({}, {}), [], "not where nothing copies it");
  page.close();
});

// A sidebar row has no "…" (T-43 rail v11): its link opens the menu at the
// context-menu key or Shift+F10, as a right-click and a long-press do.
const openRow = async (page, id, how = { key: "ContextMenu" }) => {
  const link = page.document.querySelector(`.agent-row[data-agent-id="${id}"] .agent-select`);
  link.dispatchEvent(new page.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...how }));
  await tick();
  return link;
};

test("its button opens it by click or keys, keys move through it, and Escape closes it without interrupting", async () => {
  const page = mount();
  page.window.renderHeader(agent("a", { status: "working" }));
  await tick();
  const trigger = page.document.querySelector('[aria-label="Conversation actions"]');
  assert.equal(trigger.getAttribute("aria-haspopup"), "menu");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  trigger.click();
  await tick();
  assert.ok(page.menu(), "it opened");
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(trigger.getAttribute("aria-controls"), page.menu().id);
  assert.equal(page.document.activeElement.dataset.action, "interrupt", "focus is on its first entry");
  page.key(page.document.activeElement, "ArrowDown");
  assert.equal(page.document.activeElement.dataset.action, "settings");
  page.key(page.document.activeElement, "End");
  assert.equal(page.document.activeElement.dataset.action, "manage");
  page.key(page.document.activeElement, "ArrowDown");
  assert.equal(page.document.activeElement.dataset.action, "interrupt", "it wraps around");
  page.key(page.document.activeElement, "ArrowUp");
  assert.equal(page.document.activeElement.dataset.action, "manage");
  page.key(page.document.activeElement, "Home");
  assert.equal(page.document.activeElement.dataset.action, "interrupt");
  page.key(page.document.activeElement, "Escape");
  await tick();
  assert.ok(page.menu() === null, "Escape closed it");
  assert.ok(page.document.activeElement === trigger, "focus is back on its button");
  assert.equal(page.window.interrupts, 0, "the window's Escape never saw it");
  // ArrowUp on the button opens it at its last entry.
  page.key(trigger, "ArrowUp");
  await tick();
  assert.equal(page.document.activeElement.dataset.action, "manage");
  page.key(page.document.activeElement, "Tab");
  await tick();
  assert.ok(page.menu() === null, "Tab closes it");
  assert.equal(page.calls.length, 0);
  assert.deepEqual([...page.window.opened], [], "opening the menu did not open the Agent");
  page.close();
});

test("a sidebar row has no \"…\": the context-menu key or Shift+F10 on its link opens the menu, and Escape returns there", async () => {
  const page = mount();
  page.window.renderRows([agent("a", { status: "working" })]);
  await tick();
  assert.equal(page.document.querySelector('[aria-label="Actions for A"]'), null, "no button on the row");
  assert.equal(page.document.querySelectorAll(".agent-row button").length, 1, "its link only (the ring has nowhere of its own here)");
  for (const how of [{ key: "ContextMenu" }, { key: "F10", shiftKey: true }]) {
    const link = await openRow(page, "a", how);
    assert.ok(page.menu(), `${JSON.stringify(how)} opened it`);
    assert.equal(page.document.activeElement.dataset.action, "interrupt", "focus on its first entry");
    page.key(page.document.activeElement, "Escape");
    await tick();
    assert.equal(page.menu(), null);
    assert.ok(page.document.activeElement === link, "focus back on the row's link");
  }
  // F10 alone, or another key, opens nothing.
  await openRow(page, "a", { key: "F10" });
  assert.equal(page.menu(), null);
  assert.deepEqual([...page.window.opened], [], "opening the menu did not open the Agent");
  page.close();
});

test("a right-click opens it where the pointer is; a press elsewhere closes it", async () => {
  const page = mount();
  page.window.renderRows([agent("a"), agent("b")]);
  await tick();
  const event = new page.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
  page.row("b").querySelector(".agent-name").dispatchEvent(event);
  await tick();
  assert.equal(event.defaultPrevented, true, "the browser's own menu is not shown");
  assert.equal(page.menu().getAttribute("aria-label"), "B actions");
  assert.equal(page.menu().style.left, "40px");
  assert.equal(page.menu().style.top, "60px");
  page.pointer(page.document.body, "pointerdown", { pointerType: "mouse" });
  await tick();
  assert.ok(page.menu() === null);
  assert.deepEqual([...page.window.opened], []);
  assert.equal(page.calls.length, 0);
  page.close();
});

test("a long-press opens it and the lift does not also open the Agent; a scroll, a cancel or a tap does not", async () => {
  const page = mount();
  page.window.renderRows([agent("a")]);
  await tick();
  const name = () => page.row("a").querySelector(".agent-name");
  const select = () => page.row("a").querySelector(".agent-select");
  const hold = page.window.LONG_PRESS_MS + 100;
  // Held still: the menu opens at the finger; the click of the lift is swallowed.
  page.pointer(name(), "pointerdown", { pointerType: "touch", clientX: 30, clientY: 20 });
  await tick(hold);
  assert.ok(page.menu(), "a long-press opened it");
  assert.equal(page.menu().style.left, "30px");
  page.pointer(name(), "pointerup", { pointerType: "touch" });
  select().click();
  await tick();
  assert.deepEqual([...page.window.opened], [], "the lift did not open the Agent");
  page.key(page.document.activeElement, "Escape");
  await tick();
  // A scroll: the finger moves, then the browser cancels the pointer.
  page.pointer(name(), "pointerdown", { pointerType: "touch", clientX: 30, clientY: 20 });
  page.pointer(name(), "pointermove", { pointerType: "touch", clientX: 30, clientY: 45 });
  await tick(hold);
  assert.ok(page.menu() === null, "moving more than a few pixels opens nothing");
  page.pointer(name(), "pointerdown", { pointerType: "touch", clientX: 30, clientY: 20 });
  page.pointer(name(), "pointercancel", { pointerType: "touch" });
  await tick(hold);
  assert.ok(page.menu() === null, "a cancelled touch opens nothing");
  // A tap opens the Agent, and only that.
  page.pointer(name(), "pointerdown", { pointerType: "touch", clientX: 30, clientY: 20 });
  page.pointer(name(), "pointerup", { pointerType: "touch" });
  select().click();
  await tick(hold);
  assert.ok(page.menu() === null);
  assert.deepEqual([...page.window.opened], ["a"]);
  // A mouse held down is no long-press.
  page.pointer(name(), "pointerdown", { pointerType: "mouse", clientX: 30, clientY: 20 });
  await tick(hold);
  assert.ok(page.menu() === null);
  page.pointer(name(), "pointerup", { pointerType: "mouse" });
  select().click();
  await tick();
  assert.deepEqual([...page.window.opened], ["a", "a"], "a click after a mouse press is not swallowed");
  assert.equal(page.calls.length, 0);
  page.close();
});

test("a long-press then a mouse click on the same row opens it: the swallow is cleared by the next press", async () => {
  const page = mount();
  page.window.renderRows([agent("a")]);
  await tick();
  const name = page.row("a").querySelector(".agent-name");
  page.pointer(name, "pointerdown", { pointerType: "touch", clientX: 30, clientY: 20 });
  await tick(page.window.LONG_PRESS_MS + 100);
  page.key(page.document.activeElement, "Escape");
  await tick();
  // No click followed the long-press; a later mouse click still opens the Agent.
  page.pointer(name, "pointerdown", { pointerType: "mouse" });
  page.row("a").querySelector(".agent-select").click();
  await tick();
  assert.deepEqual([...page.window.opened], ["a"]);
  page.close();
});

test("each entry acts once on the Agent it was opened on, and sends no message", async () => {
  let release;
  const page = mount((url) => (url.includes("/reconnect") ? new Promise((resolve) => { release = () => resolve({ body: {} }); }) : {}));
  page.window.renderRows([agent("a", { status: "offline", connectionState: "disconnected" }), agent("b", { status: "working" })]);
  await tick();
  const open = (id) => openRow(page, id);
  await open("a");
  page.item("reconnect").click();
  await tick();
  assert.ok(page.menu() === null, "running an entry closes the menu");
  // Again while the first is still on its way: nothing more is sent.
  await open("a");
  page.item("reconnect").click();
  await tick();
  assert.deepEqual(page.calls.map((c) => `${c.method} ${c.url}`), ["POST /api/agents/a/reconnect?view=summary"]);
  release();
  await tick();
  assert.deepEqual([...page.window.done], ["reconnected:a", "reconnected:a"]);
  // Another Agent's entries act on that one.
  await open("b");
  page.item("interrupt").click();
  await tick();
  assert.equal(page.calls.at(-1).url, "/api/agents/b/interrupt");
  await open("b");
  page.item("settings").click();
  await open("a");
  page.item("manage").click();
  await tick();
  assert.deepEqual([...page.window.done.slice(2)], ["interrupted:b", "settings:b", "manage:a"]);
  assert.ok(page.calls.every((c) => !c.url.includes("/messages")), "no message was sent");
  page.close();
});

test("a disabled entry runs nothing, and a failure is reported for that Agent", async () => {
  const page = mount((url) => (url.includes("/reconnect") ? { status: 400, body: { error: "Could not start Codex" } } : {}));
  page.window.renderRows([agent("a", { status: "offline", connectionState: "connecting" }), agent("b", { status: "offline", connectionState: "disconnected" })]);
  await tick();
  await openRow(page, "a");
  assert.equal(page.item("reconnect").disabled, true);
  page.item("reconnect").click();
  await tick();
  assert.equal(page.calls.length, 0, "Core is already connecting it");
  page.key(page.document.activeElement, "Escape");
  await tick();
  await openRow(page, "b");
  page.item("reconnect").click();
  await tick();
  await tick();
  assert.deepEqual([...page.window.failed], ["b: Could not start Codex"]);
  // A failed request may be tried again.
  await openRow(page, "b");
  page.item("reconnect").click();
  await tick();
  await tick();
  assert.equal(page.calls.length, 2);
  page.close();
});

test("a menu opened for one Agent closes when its control comes to show another", async () => {
  const page = mount();
  page.window.renderHeader(agent("a", { status: "working" }));
  await tick();
  page.document.querySelector('[aria-label="Conversation actions"]').click();
  await tick();
  assert.equal(page.menu().getAttribute("aria-label"), "A actions");
  // The selection moves to B while A's menu is open.
  page.window.renderHeader(agent("b", { status: "working" }));
  await tick();
  assert.ok(page.menu() === null, "A's menu closed instead of acting on B");
  assert.equal(page.calls.length, 0);
  assert.deepEqual([...page.window.done], []);
  page.close();
});

test("a scroll closes it only when it moves where it opened: a conversation following a running turn leaves it open", async () => {
  const page = mount();
  const scroll = (target) => target.dispatchEvent(new page.window.Event("scroll"));
  // Another pane, as the conversation under the header, scrolling as output grows.
  const pane = page.document.createElement("div");
  page.document.body.append(pane);
  page.window.renderHeader(agent("a", { status: "working" }));
  await tick();
  page.document.querySelector('[aria-label="Conversation actions"]').click();
  await tick();
  scroll(pane);
  await tick();
  assert.ok(page.menu(), "still open while the conversation scrolls");
  page.item("interrupt").click();
  await tick();
  assert.deepEqual(page.calls.map((c) => `${c.method} ${c.url}`), ["POST /api/agents/a/interrupt"]);
  // In the list: another pane's scroll leaves it open; the list it is in, or
  // the page, scrolling moves the row it opened from and closes it.
  page.window.renderRows([agent("b")]);
  await tick();
  await openRow(page, "b");
  scroll(pane);
  await tick();
  assert.ok(page.menu(), "another pane's scroll leaves it open");
  scroll(page.document.getElementById("root"));
  await tick();
  assert.equal(page.menu(), null, "the list it is in scrolled: closed");
  await openRow(page, "b");
  assert.ok(page.menu());
  scroll(page.document);
  await tick();
  assert.equal(page.menu(), null, "the page scrolled: closed");
  page.close();
});

test("a touch held shows it is held from 150 ms until the actions open; a move past the slop, a lift or a cancel lets go at once (T-19 SH:R13)", async () => {
  const page = mount();
  page.window.renderRows([agent("a")]);
  await tick();
  const name = () => page.row("a").querySelector(".agent-name");
  const holding = () => page.row("a").classList.contains("is-holding");
  const down = () => page.pointer(name(), "pointerdown", { pointerType: "touch", clientX: 30, clientY: 20 });
  down();
  await tick(90);
  assert.equal(holding(), false, "not at once: a tap shows nothing");
  await tick(130);
  assert.equal(holding(), true, "held past 150 ms: it shows");
  await tick(page.window.LONG_PRESS_MS);
  assert.ok(page.menu(), "the actions opened");
  assert.equal(holding(), false, "and the row is let go as they open");
  page.pointer(name(), "pointerup", { pointerType: "touch" });
  page.key(page.document.activeElement, "Escape");
  await tick();
  for (const [how, end] of [
    ["a move past the slop", () => page.pointer(name(), "pointermove", { pointerType: "touch", clientX: 30, clientY: 45 })],
    ["a lift", () => page.pointer(name(), "pointerup", { pointerType: "touch" })],
    ["a cancel", () => page.pointer(name(), "pointercancel", { pointerType: "touch" })],
  ]) {
    down();
    await tick(220);
    assert.equal(holding(), true, `held, before ${how}`);
    end();
    // A move renders at React's continuous priority, not in the event itself: a tick, far short of the hold.
    await tick();
    assert.equal(holding(), false, `${how} lets it go at once`);
    await tick(page.window.LONG_PRESS_MS);
    assert.equal(page.menu(), null, `${how} opens nothing`);
  }
  page.pointer(name(), "pointerdown", { pointerType: "mouse", clientX: 30, clientY: 20 });
  await tick(220);
  assert.equal(holding(), false, "a mouse held down shows nothing");
  page.pointer(name(), "pointerup", { pointerType: "mouse" });
  page.close();
});

// The row's card (YN-44): the app's one tip, for the whole row and its ring.
const shownCard = (page) => page.document.querySelector('.tip[role="tooltip"]');

test("the row's card opens after the pointer rests 300 ms, at once from the keyboard; a press, a touch or a leave opens nothing; Escape closes it without interrupting", async () => {
  const page = mount();
  try {
    page.window.renderRows([agent("a", { workSummary: { kind: "progress", source: "agent", text: "Writing the import test" } }), agent("b")]);
    await tick();
    const row = page.row("a");
    const select = row.querySelector(".agent-select");
    page.pointer(row, "pointermove", { pointerType: "mouse" });
    await tick(150);
    assert.equal(shownCard(page), null, "not before its delay");
    await tick(300);
    assert.ok(shownCard(page), "open once the pointer rested");
    assert.deepEqual(tipLines(shownCard(page)), ["A", "Idle", "Update · Writing the import test", "Core host"],
      "its name, its state, what it last said in full, where it runs; nothing about where a click goes");
    // Leaving the row closes it at once.
    page.pointer(row, "pointerout", { pointerType: "mouse", relatedTarget: page.document.body });
    await tick();
    assert.equal(shownCard(page), null, "closed on leaving");
    // The keyboard: at once, and Escape closes it, taken before App's interrupt.
    const started = Date.now();
    await openTip(page.window, select);
    assert.ok(Date.now() - started < 250, "no delay for the keyboard");
    page.key(page.document.activeElement, "Escape");
    await tick();
    assert.equal(shownCard(page), null, "Escape closed it");
    assert.equal(page.window.interrupts, 0, "the Escape that closed it interrupted nothing");
    select.blur();
    // A press focuses the link on its way to a click: that focus opens nothing.
    page.pointer(select, "pointerdown", { pointerType: "mouse" });
    select.focus();
    page.pointer(select, "pointerup", { pointerType: "mouse" });
    await tick(450);
    assert.equal(shownCard(page), null, "a press's focus opens nothing");
    select.blur();
    // A finger moving over the row opens nothing.
    page.pointer(row, "pointermove", { pointerType: "touch" });
    await tick(450);
    assert.equal(shownCard(page), null, "nothing on touch");
    // Its actions from the keyboard: the menu's focus reaches the row through
    // React (a portal), and opens no card over the menu.
    await openTip(page.window, select);
    page.key(select, "ContextMenu");
    await tick();
    assert.ok(page.menu(), "the actions");
    assert.equal(shownCard(page), null, "no card over the menu");
    page.key(page.document.activeElement, "Escape");
    await tick();
    assert.equal(page.menu(), null, "one Escape closes the menu");
  } finally {
    page.close();
  }
});

test("a touch held on the ring shows the row's card, not the actions; it stays after the lift, the next tap only closes it; held elsewhere or right-clicked, the actions open", async () => {
  const page = mount();
  try {
    page.window.renderRows([agent("a"), agent("b")]);
    await tick();
    const ring = () => page.row("a").querySelector(".agent-island");
    const hold = page.window.LONG_PRESS_MS + 100;
    page.pointer(ring(), "pointerdown", { pointerType: "touch", clientX: 200, clientY: 20 });
    await tick(hold);
    assert.ok(shownCard(page), "the card");
    assert.equal(page.menu(), null, "not the actions");
    // The lift: the finger leaves the row, and its click opens nothing; the card stays.
    page.pointer(ring(), "pointerup", { pointerType: "touch" });
    page.pointer(page.row("a"), "pointerout", { pointerType: "touch", relatedTarget: page.document.body });
    page.row("a").querySelector(".agent-select").click();
    await tick();
    assert.ok(shownCard(page), "still shown after the lift");
    assert.deepEqual([...page.window.opened], [], "the lift opened nothing");
    // The next tap, on another row: it closes the card and does nothing else.
    const other = page.row("b").querySelector(".agent-select");
    page.pointer(other, "pointerdown", { pointerType: "touch", clientX: 30, clientY: 60 });
    await tick();
    assert.equal(shownCard(page), null, "closed by the next tap");
    page.pointer(other, "pointerup", { pointerType: "touch" });
    other.click();
    await tick();
    assert.deepEqual([...page.window.opened], [], "that tap opened nothing");
    // The tap after it opens the Agent, as ever.
    page.pointer(other, "pointerdown", { pointerType: "touch", clientX: 30, clientY: 60 });
    page.pointer(other, "pointerup", { pointerType: "touch" });
    other.click();
    await tick();
    assert.deepEqual([...page.window.opened], ["b"]);
    // Held anywhere else on the row: its actions.
    page.pointer(page.row("a").querySelector(".agent-name"), "pointerdown", { pointerType: "touch", clientX: 30, clientY: 20 });
    await tick(hold);
    assert.ok(page.menu(), "the actions");
    assert.equal(shownCard(page), null);
    page.pointer(page.row("a").querySelector(".agent-name"), "pointerup", { pointerType: "touch" });
    page.key(page.document.activeElement, "Escape");
    await tick();
    // A right-click on the ring (a mouse press, then its menu): its actions too.
    page.pointer(ring(), "pointerdown", { pointerType: "mouse", button: 2, clientX: 200, clientY: 20 });
    ring().dispatchEvent(new page.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 20 }));
    await tick();
    assert.ok(page.menu(), "a right-click on the ring opens the actions");
    assert.equal(shownCard(page), null);
  } finally {
    page.close();
  }
});
