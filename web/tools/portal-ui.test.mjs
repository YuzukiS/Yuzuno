import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { JSDOM, VirtualConsole } from "jsdom";

// T-5: the Portal and the ways into it. The real OpenChoice, Portal shell,
// Turn and Settings section, in JSDOM, with Core answered by a fixture; no
// Core, browser or web/dist writes. What a real browser enforces (the
// sandbox, the preview origin's headers) is checked in Chromium elsewhere.
const root = fileURLToPath(new URL("../", import.meta.url));
const cache = path.join(root, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const fixture = await mkdtemp(path.join(cache, "portal-ui-"));
let bundle;
try {
  const entry = path.join(fixture, "entry.tsx");
  const src = (file) => JSON.stringify(path.join(root, "src", file));
  await writeFile(
    entry,
    `import React from 'react';
import {flushSync} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {OpenChoice} from ${src("portal/OpenChoice.tsx")};
import {PortalPreferencesSection} from ${src("portal/PortalPreferences.tsx")};
import {Turn} from ${src("components.tsx")};
import {closePortal, openInPortal} from ${src("portal/index.ts")};
import {saveOpenWith} from ${src("portal/portal-preference.ts")};
const root=createRoot(document.getElementById('root'));
const shell=(child)=><div className="app"><aside className="rail"/><main className="main-panel"><button id="before">before</button>{child}</main><aside className="inspector"/></div>;
window.renderChoice=(target,onSource,onOpened)=>flushSync(()=>root.render(shell(<OpenChoice target={()=>target} onSource={onSource} onOpened={onOpened}/>)));
window.renderSettings=()=>flushSync(()=>root.render(<PortalPreferencesSection/>));
window.renderTurn=(turn,agent,onFile)=>flushSync(()=>root.render(shell(<Turn turn={turn} index={0} agent={agent} onFile={onFile}/>)));
window.portal={open:openInPortal,close:closePortal,saveOpenWith};`,
  );
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, lib: { entry, name: "PortalUi", formats: ["iife"] } },
  });
  bundle = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === "chunk").code;
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, description, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await tick(15);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

const PREVIEW = "http://127.0.0.1:4383/v/tok";
const PROOF = "http://127.0.0.1:4383/.well-known/yuzuno-preview/ch";
const minted = { name: "pomodoro.html", size: 6200, sha256: "ab", takenAt: "2026-10-28T22:14:00Z", expiresAt: "2026-10-28T23:14:00Z",
  port: 4383, url: PREVIEW, proof: { challenge: "ch", answer: "ans", url: PROOF } };

function mount({ respond, width = 1440, storage = true } = {}) {
  const errors = [];
  const requests = [];
  const opened = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://isolated.test/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole,
  });
  const { window } = dom;
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.open = (...args) => { opened.push(args); return null; };
  if (!storage) {
    const refuse = () => { const e = new Error("blocked"); e.name = "SecurityError"; throw e; };
    Object.defineProperty(window, "localStorage", { value: { getItem: () => null, setItem: refuse, removeItem: refuse }, configurable: true });
  }
  window.fetch = async (url, init = {}) => {
    const request = { url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(request);
    const answer = (await respond?.(request)) ?? (request.url === PROOF ? { text: "ans" } : request.url.endsWith("/api/previews") ? { body: minted } : { body: {} });
    const { status = 200, body = {}, text } = answer;
    return { ok: status < 400, status, json: async () => body, text: async () => text ?? JSON.stringify(body) };
  };
  window.eval(bundle);
  const document = window.document;
  const panel = () => document.querySelector(".portal-panel");
  const frame = () => document.querySelector(".portal-panel iframe");
  const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const button = (label, scope = document) => [...scope.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
  return { window, document, errors, requests, opened, panel, frame, click, button, close: () => window.close() };
}

const snapshot = { kind: "snapshot", source: { kind: "artifact", agentId: "a", path: "pomodoro.html" }, name: "pomodoro.html", from: "Mori 的会话文件" };
const service = (connection = {}, extra = {}) => ({
  id: "s1", projectId: "p1", machineId: "local", port: 5173, path: "/", name: "看板开发服务", author: { kind: "user" }, createdAt: "",
  connection: { state: "available", localPort: 4381, httpStatus: 200, framing: "allowed", since: "", ...connection }, ...extra,
});
const serviceTarget = (s) => ({ kind: "service", service: s, url: "http://127.0.0.1:4381/", where: "Core 主机 · 端口 5173" });

test("a prototype opens beside the chat only once this browser proves it reaches the preview port, scripts-only, and closing unmounts it", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderChoice(snapshot);
  const main = page.document.querySelector(".open-choice-split .primary-button");
  assert.match(main.textContent, /Preview beside/);
  main.focus();
  page.click(main);
  const frame = await until(page.frame, "the prototype's frame");
  assert.deepEqual(page.requests.slice(0, 2).map((r) => [r.method, r.url, r.body]), [
    ["POST", "/api/previews", { kind: "artifact", agentId: "a", path: "pomodoro.html" }],
    ["GET", PROOF, undefined],
  ], "kept as a snapshot, then its port proven, before any frame");
  assert.equal(frame.getAttribute("src"), PREVIEW);
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts", "scripts only: no same-origin, forms, popups or top navigation");
  assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
  assert.match(page.panel().textContent, /Isolated preview/);
  assert.match(page.panel().textContent, /isn't cut off from the network/, "says what isolation doesn't stop");
  // Its first load is the snapshot; a later one is somewhere it went, which isn't shown.
  frame.dispatchEvent(new page.window.Event("load"));
  frame.dispatchEvent(new page.window.Event("load"));
  await until(() => !page.frame(), "the frame removed after the page moved on");
  assert.match(page.panel().textContent, /loaded something else, so it is no longer shown here/);
  page.click(page.button("Back to the snapshot"));
  const again = await until(page.frame, "the snapshot framed again");
  assert.notEqual(again, frame, "a new frame");
  assert.equal(again.getAttribute("src"), PREVIEW);
  again.dispatchEvent(new page.window.Event("load"));
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(page.frame(), again, "its own first load stays shown");
  // Beside the chat: the app's grid gives the Portal two thirds of the content area.
  const html = page.document.documentElement;
  assert.equal(html.dataset.portal, "side");
  assert.equal(html.style.getPropertyValue("--portal-columns"), "minmax(0, 1fr) 960px");
  assert.equal(page.panel().getAttribute("role"), "complementary");
  page.click(page.button("Close preview"));
  await until(() => !page.panel(), "the panel closed");
  assert.equal(page.frame(), null, "the page is unmounted");
  assert.equal(html.dataset.portal, undefined);
  assert.equal(page.document.activeElement, main, "focus back where it came from");
  assert.deepEqual(page.errors, []);
});

test("without a proven port, or when Core refuses the file, no page is framed and the Portal says why", async (t) => {
  const unreachable = mount({ respond: (r) => (r.url === PROOF ? { text: "something else" } : undefined) });
  t.after(unreachable.close);
  unreachable.window.renderChoice(snapshot);
  unreachable.click(unreachable.document.querySelector(".open-choice-split .primary-button"));
  await until(() => unreachable.panel()?.querySelector('[role="alert"]'), "the explanation");
  assert.equal(unreachable.frame(), null);
  assert.match(unreachable.panel().textContent, /Isolated previews don't open through this connection/);
  const refused = mount({ respond: (r) => (r.url.endsWith("/api/previews") ? { status: 400, body: { error: "preview_too_large: a previewed page is at most 2 MB" } } : undefined) });
  t.after(refused.close);
  refused.window.renderChoice(snapshot);
  refused.click(refused.document.querySelector(".open-choice-split .primary-button"));
  await until(() => refused.panel()?.querySelector('[role="alert"]'), "the refusal");
  assert.equal(refused.frame(), null);
  assert.match(refused.panel().textContent, /This file can't be previewed: preview_too_large/);
  assert.ok(!refused.requests.some((r) => r.url === PROOF), "nothing is proven for a refused file");
});

test("the device's default is the main button and the other way is there for this once", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.portal.saveOpenWith("browser");
  let closed = 0;
  page.window.renderChoice(snapshot, () => page.window.__source = true, () => closed++);
  const main = page.document.querySelector(".open-choice-split .primary-button");
  assert.match(main.textContent, /Open in browser/);
  page.click(main);
  await until(() => page.opened.length, "the browser opened");
  assert.deepEqual(page.opened[0], [PREVIEW, "_blank", "noopener,noreferrer"], "the proven snapshot, with no handle on this window");
  assert.equal(page.panel(), null, "nothing inside");
  assert.ok(page.document.querySelector('.open-choice-note a[href="' + PREVIEW + '"]'), "a link if the tab was blocked");
  assert.equal(closed, 0, "what holds the link (a dialog) stays open");
  // Once, inside: the default stays the browser.
  page.click(page.button("Other ways to open"));
  await until(() => page.document.querySelector(".open-choice-menu"), "the menu");
  const items = [...page.document.querySelectorAll('.open-choice-menu [role="menuitem"]')].map((b) => b.textContent);
  assert.deepEqual(items, ["Open in browserThis device's default", "Preview besideThis time only", "View sourceShown as text, not run"]);
  page.click([...page.document.querySelectorAll('.open-choice-menu [role="menuitem"]')][1]);
  await until(page.frame, "the frame, this once");
  assert.equal(closed, 1, "opened inside: nothing more is needed there");
  assert.match(page.document.querySelector(".open-choice-split .primary-button").textContent, /Open in browser/, "default unchanged");
  assert.equal(page.window.localStorage.getItem("yuzuno.portal-open"), JSON.stringify({ open: "browser" }));
  page.click(page.button("Other ways to open"));
  await until(() => page.document.querySelector(".open-choice-menu"), "the menu again");
  page.click([...page.document.querySelectorAll('.open-choice-menu [role="menuitem"]')][2]);
  assert.equal(page.window.__source, true, "the source, when asked for");
});

test("on a narrow window the Portal is full screen, as a dialog with a way back", async (t) => {
  const page = mount({ width: 393 });
  t.after(page.close);
  page.window.renderChoice(snapshot);
  const main = page.document.querySelector(".open-choice-split .primary-button");
  assert.match(main.textContent, /Preview full screen/);
  page.click(main);
  await until(page.frame, "the frame");
  assert.equal(page.document.documentElement.dataset.portal, "full");
  assert.ok(page.panel().classList.contains("is-full"));
  assert.equal(page.panel().getAttribute("aria-modal"), "true");
  assert.equal(page.document.querySelector(".portal-grip"), null, "nothing to drag");
  page.click(page.button("Back to the conversation"));
  await until(() => !page.panel(), "closed");
});

// A conversation pane that scrolls, its geometry given: beside the Portal the
// narrower chat is 500 px taller above the card (jsdom lays nothing out).
function readingPane(page) {
  const html = page.document.documentElement;
  const pane = page.document.querySelector(".main-panel");
  pane.classList.add("conversation-scroll");
  pane.style.overflowY = "auto";
  const state = { top: 745 };
  Object.defineProperty(pane, "scrollHeight", { value: 5000, configurable: true });
  Object.defineProperty(pane, "clientHeight", { value: 600, configurable: true });
  Object.defineProperty(pane, "scrollTop", { get: () => state.top, set: (v) => { state.top = v; }, configurable: true });
  pane.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 400, height: 600, width: 400 });
  const place = (el, closed, beside, height = 40) => {
    el.getBoundingClientRect = () => {
      const y = (html.dataset.portal === "side" ? beside : closed) - state.top;
      return { top: y, bottom: y + height, left: 0, right: 200, height, width: 200 };
    };
  };
  return { html, pane, state, place };
}

test("opening and closing beside the chat keeps the reader's place: the card it opened from, else the message in view", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderChoice(snapshot);
  const { html, pane, state, place } = readingPane(page);
  const main = page.document.querySelector(".open-choice-split .primary-button");
  place(main, 1000, 1500);
  assert.equal(main.getBoundingClientRect().top, 255);
  page.click(main);
  await until(page.frame, "the prototype's frame");
  await until(() => html.dataset.portal === "side", "beside the chat");
  assert.equal(state.top, 1245, "scrolled by the 500 px the chat grew");
  assert.equal(main.getBoundingClientRect().top, 255, "the card stays where it was");
  page.click(page.button("Close preview"));
  await until(() => !page.panel(), "closed");
  assert.equal(state.top, 745, "and back by as much when the chat widens again");
  assert.equal(page.document.activeElement, main, "focus back on it");
  // Scrolled on, past the card, while the page is open: closing keeps the message read then.
  page.click(main);
  await until(() => html.dataset.portal === "side", "open again");
  await new Promise((done) => setTimeout(done, 300));
  state.top = 2245;
  const message = page.document.createElement("div");
  message.dataset.itemId = "m2";
  pane.append(message);
  place(message, 1800, 2500, 80);
  assert.equal(message.getBoundingClientRect().top, 255, "the message read now");
  page.click(page.button("Close preview"));
  await until(() => !page.panel(), "closed again");
  assert.equal(message.getBoundingClientRect().top, 255, "the message read stays where it was");
  assert.equal(state.top, 1545, "not pulled back to the card");
  // In a long message, the paragraph on the reading line holds, not the message's top.
  page.click(main);
  await until(() => html.dataset.portal === "side", "open a third time");
  await new Promise((done) => setTimeout(done, 300));
  state.top = 2245;
  const paragraph = page.document.createElement("p");
  message.append(paragraph);
  place(paragraph, 2100, 2500, 24);
  page.document.elementFromPoint = () => paragraph;
  page.click(page.button("Close preview"));
  await until(() => !page.panel(), "closed a third time");
  assert.equal(paragraph.getBoundingClientRect().top, 255, "the paragraph read stays where it was");
  assert.equal(state.top, 1845);
  assert.deepEqual(page.errors, []);
});

test("a reader's own scroll right after the Portal opens wins over holding the place", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderChoice(snapshot);
  const { html, pane, state, place } = readingPane(page);
  const main = page.document.querySelector(".open-choice-split .primary-button");
  place(main, 1000, 1500);
  page.click(main);
  await until(() => html.dataset.portal === "side", "beside the chat");
  assert.equal(state.top, 1245);
  // The wheel turns before the frames that hold the place have run.
  pane.dispatchEvent(new page.window.WheelEvent("wheel", { deltaY: 600, bubbles: true }));
  state.top = 3000;
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(state.top, 3000, "left where the reader scrolled");
  assert.deepEqual(page.errors, []);
});

test("a full-screen Portal leaves the chat's scroll alone", async (t) => {
  const page = mount({ width: 393 });
  t.after(page.close);
  page.window.renderChoice(snapshot);
  const { html, state, place } = readingPane(page);
  const main = page.document.querySelector(".open-choice-split .primary-button");
  place(main, 1000, 1500);
  page.click(main);
  await until(() => html.dataset.portal === "full", "full screen");
  await new Promise((done) => setTimeout(done, 200));
  page.click(page.button("Back to the conversation"));
  await until(() => !page.panel(), "closed");
  assert.equal(state.top, 745, "never scrolled");
});

test("the panel's width follows the grip and is kept on this device", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderChoice(snapshot);
  page.window.portal.open(snapshot);
  const grip = await until(() => page.document.querySelector(".portal-grip"), "the grip");
  grip.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await until(() => page.document.documentElement.style.getPropertyValue("--portal-width") === "992px", "wider by a step");
  assert.equal(page.window.localStorage.getItem("yuzuno.portal-width"), JSON.stringify({ px: 992 }));
  // The chat keeps its minimum: the Portal never takes more than the content less 320 px.
  // Held keys (no render between them), and the chat keeps its minimum: content less 320 px.
  for (let i = 0; i < 10; i++) grip.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await until(() => page.document.documentElement.style.getPropertyValue("--portal-width") === "1120px", "capped");
  assert.equal(page.window.localStorage.getItem("yuzuno.portal-width"), JSON.stringify({ px: 1120 }), "kept within the cap");
  grip.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await until(() => page.document.documentElement.style.getPropertyValue("--portal-width") === "1088px", "narrower at once");
  page.window.portal.close();
});

test("a service opens in its own frame that can't move this window; one that refuses framing opens only in the browser", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.portal.open(serviceTarget(service()));
  const frame = await until(page.frame, "the service frame");
  assert.equal(frame.getAttribute("src"), "http://127.0.0.1:4381/");
  const sandbox = frame.getAttribute("sandbox").split(" ");
  assert.ok(sandbox.includes("allow-scripts") && sandbox.includes("allow-same-origin"));
  assert.ok(!sandbox.some((flag) => flag.startsWith("allow-top-navigation")), "never navigates this window");
  // A service moves between its own pages: it stays shown.
  frame.dispatchEvent(new page.window.Event("load"));
  frame.dispatchEvent(new page.window.Event("load"));
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(page.frame(), frame);
  page.window.portal.open(serviceTarget(service({ framing: "blocked" })));
  await until(() => !page.frame() && page.panel()?.querySelector(".portal-blocked"), "the blocked state");
  assert.match(page.panel().textContent, /doesn't allow being shown inside Yuzuno/);
  page.click(page.button("Open in browser", page.panel().querySelector(".portal-blocked")));
  assert.deepEqual(page.opened.at(-1), ["http://127.0.0.1:4381/", "_blank", "noopener,noreferrer"]);
});

test("a service's Job: running, reachable and health apart; stop only for its own Job after a confirmation; external ones never stop", async (t) => {
  const page = mount();
  t.after(page.close);
  const job = { jobId: "j1", status: "running", owner: "verified", earlierJobIds: [], canStop: true };
  page.window.portal.open(serviceTarget(service({}, { job, health: { declared: false } })));
  const section = await until(() => page.panel()?.querySelector(".portal-job"), "the Job");
  const facts = [...section.querySelectorAll(".portal-fact")].map((f) => f.textContent);
  // The Job as the list says now; the page as its last check found it, apart.
  assert.deepEqual(facts, ["ProcessRunningLinked to this Job", "Page (last check)ReachableHTTP 200", "Health checkNot set"]);
  page.click(page.button("Stop Job…", section));
  const confirm = await until(() => page.button("Stop the Job", section), "the confirmation");
  assert.ok(!page.requests.some((r) => r.url.includes("/cancel")), "nothing stopped before the confirmation");
  page.click(confirm);
  await until(() => page.requests.some((r) => r.method === "POST" && r.url === "/api/jobs/j1/cancel"), "the cancel");
  page.click(page.button("Disconnect", section));
  await until(() => page.requests.some((r) => r.method === "POST" && r.url === "/api/services/s1/close"), "the disconnect");
  await until(() => page.panel().textContent.includes("Disconnected. The service itself keeps running."), "said");
  assert.equal(page.frame(), null);
  // External: no Job to stop.
  page.window.portal.open(serviceTarget(service({}, { job: null })));
  const external = await until(() => [...page.document.querySelectorAll(".portal-job")].find((s) => s.textContent.includes("External service")), "the external service");
  assert.match(external.textContent, /External service.*Not started by Yuzuno/);
  assert.match(external.textContent, /Yuzuno doesn't stop this service/);
  assert.equal(page.button("Stop Job…", external), undefined);
  // Another program on the port is said so, not called ours.
  page.window.portal.open(serviceTarget(service({}, { job: { ...job, owner: "otherProcess" }, health: { declared: true, path: "/health", state: "failing" } })));
  const other = await until(() => [...page.document.querySelectorAll(".portal-job")].find((s) => s.textContent.includes("Another program")), "the conflict");
  assert.match(other.textContent, /Another program answers on its port/);
  assert.match(other.textContent, /Health checkFailing/);
  // Whose listener it is can't be told: never called the Job's. The page's check says when it was.
  page.window.portal.open(serviceTarget(service({ since: "2026-10-29T00:37:00Z" }, {
    job: { ...job, status: "starting", owner: "unknown" }, health: { declared: true, path: "/health", state: "failing", reason: "HTTP 500" } })));
  const unsure = await until(() => [...page.document.querySelectorAll(".portal-job")].find((s) => s.textContent.includes("Can't confirm")), "the unknown owner");
  assert.doesNotMatch(unsure.textContent, /Linked to this Job/);
  assert.match(unsure.textContent, /ProcessStartingCan't confirm whose program answers on the port/);
  assert.match(unsure.textContent, /Page \(last check\)Reachable\d{1,2}:\d{2}[^·]* · HTTP 200/);
  assert.match(unsure.textContent, /Health checkFailingHTTP 500/);
  assert.ok(page.button("Stop Job…", unsure), "a starting Job can still be stopped (canStop)");
  // While it is being stopped: said so, and no second stop.
  page.window.portal.open(serviceTarget(service({}, { job: { ...job, status: "cancelling", owner: "notListening", canStop: false } })));
  const stopping = await until(() => [...page.document.querySelectorAll(".portal-job")].find((s) => s.textContent.includes("Stopping")), "the stopping Job");
  assert.match(stopping.textContent, /This Job isn't listening on the port/);
  assert.equal(page.button("Stop Job…", stopping), undefined);
  // A way that isn't open is no check of the page: no reachability, time or code from it.
  page.window.portal.open(serviceTarget(service({ state: "disconnected", httpStatus: undefined, since: "2026-10-29T00:40:00Z" }, { job: { ...job, status: "running" } })));
  const closed = await until(() => [...page.document.querySelectorAll(".portal-job")].find((s) => s.textContent.includes("Not connected")), "the closed way");
  const closedFacts = [...closed.querySelectorAll(".portal-fact")].map((f) => f.textContent);
  assert.equal(closedFacts[1], "PageNot connected");
});

test("a finished Turn's HTML files are offered as prototypes; a deleted one or a running Turn's are not", async (t) => {
  const page = mount();
  t.after(page.close);
  const agent = { id: "a", name: "Mori", harness: "codex", color: "sage", status: "idle", cwd: "/w", goal: "", model: "",
    createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 0, reviewedSeq: 0 };
  const items = [
    { id: "u", type: "userMessage", content: [{ type: "text", text: "Make a timer" }] },
    { id: "f", type: "fileChange", status: "completed", changes: [
      { path: "/w/pomodoro.html", kind: { type: "add" } }, { path: "/w/old.html", kind: { type: "delete" } }, { path: "/w/app.js", kind: { type: "add" } }] },
    { id: "m", type: "agentMessage", text: "Done." },
  ];
  let sourced = null;
  page.window.renderTurn({ id: "t", status: "completed", items }, agent, (p) => (sourced = p));
  const cards = [...page.document.querySelectorAll(".turn-file")];
  assert.deepEqual(cards.map((c) => c.querySelector("strong").textContent), ["pomodoro.html"]);
  page.click(page.button("Other ways to open", cards[0]));
  await until(() => cards[0].querySelector('[role="menuitem"]'), "the card's menu");
  page.click([...cards[0].querySelectorAll('[role="menuitem"]')][2]);
  assert.equal(sourced, "/w/pomodoro.html");
  page.window.renderTurn({ id: "t", status: "inProgress", items }, { ...agent, status: "working" }, () => {});
  assert.equal(page.document.querySelectorAll(".turn-file").length, 0, "not while the Turn runs");
});

test("Settings: the default is chosen and kept on this device, and a refused save is said so", async (t) => {
  const page = mount();
  t.after(page.close);
  page.window.renderSettings();
  const radio = (value) => page.document.querySelector(`input[name="portal-open-with"][value="${value}"]`);
  assert.equal(radio("inside").checked, true, "inside Yuzuno when unset");
  page.click(radio("browser"));
  await until(() => radio("browser").checked, "chosen");
  assert.equal(page.window.localStorage.getItem("yuzuno.portal-open"), JSON.stringify({ open: "browser" }));
  const blocked = mount({ storage: false });
  t.after(blocked.close);
  blocked.window.renderSettings();
  blocked.click(blocked.document.querySelector('input[name="portal-open-with"][value="browser"]'));
  await until(() => blocked.document.querySelector('input[name="portal-open-with"][value="browser"]').checked, "applies here");
  assert.ok(blocked.document.querySelector('[role="alert"], [role="status"]')?.textContent, "the refusal is said");
});
