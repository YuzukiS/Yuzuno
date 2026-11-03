import "./jsdom-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { uiTestBundle } from "./ui-test-bundle.mjs";

// A dialog's exit (T-19 M1, DialogExitGhost.tsx): Radix removes the dialog at
// once, and a copy that nothing can reach fades out instead. jsdom has no Web
// Animations, so the app makes no copy there; these tests give it a stub
// `animate` to make one. jsdom plays no CSS animation either, so the copy
// goes by its 400 ms fallback. Timing, focus and clicks are checked in
// Chromium (motion-1b-check.mjs).
const dist = pathToFileURL(resolve(process.env.YUZUNO_UI_DIST || "dist") + "/");
const html = await readFile(new URL("index.html", dist), "utf8");
const bundle = await uiTestBundle(new URL(html.match(/src="\/(assets\/[^" ]+\.js)"/)[1], dist));
const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));
async function waitFor(read, message, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(message);
    await pause(25);
  }
}

const agent = (id, name) => ({
  id, name, goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected",
});
const agents = [agent("a", "Mori"), agent("b", "Hana")];
const budget = {
  machine: { name: "Host", memoryAvailableMiB: 4096, scope: "" },
  budget: { cpuMillis: 4000, memoryMiB: 8192, swapMiB: 0 }, reserved: { cpuMillis: 0, memoryMiB: 0, swapMiB: 0 },
  activeCount: 0, queuedCount: 0,
};

async function mount({ animations = true, reduced = false } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e.message));
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', {
    url: "http://127.0.0.1:4492/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc,
  });
  const w = dom.window;
  w.matchMedia = (media) => ({ media, matches: reduced && /reduced-motion: reduce/.test(media), addEventListener() {}, removeEventListener() {} });
  if (animations) w.Element.prototype.animate = () => ({ addEventListener() {}, cancel() {}, finished: Promise.resolve() });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.EventSource = class { addEventListener() {} close() {} };
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.scrollTo = () => {};
  const project = { id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" };
  const response = (body) => ({ ok: true, status: 200, json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
  w.fetch = async (url) => {
    const path = new URL(String(url), "http://127.0.0.1:4492").pathname;
    if (path === "/api/workspace") return response({ workspace: { id: "fixture" }, agents, projects: [project], runtime: { connected: true }, defaultCwd: "/w" });
    const detail = /^\/api\/agents\/([ab])$/.exec(path);
    if (detail) return response({ agent: agents.find((a) => a.id === detail[1]), pending: [], artifacts: [], turns: [] });
    if (path === "/api/jobs") return response({ jobs: [], hasMore: false, nextBefore: null });
    if (path === "/api/jobs/budget") return response(budget);
    return response({});
  };
  w.eval(bundle);
  const doc = w.document;
  await waitFor(() => doc.querySelector('[data-composer-input][aria-label="Message Mori"]'), "Mori is open");
  return { w, doc, errors, close: () => w.close() };
}
const ghost = (page) => page.doc.querySelector(".dialog-exit-ghost");
const dialogs = (page) => [...page.doc.querySelectorAll('[role="dialog"]')].filter((el) => !ghost(page)?.contains(el));
const escape = (page) => page.doc.activeElement.dispatchEvent(new page.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

async function openNewAgent(page) {
  const add = await waitFor(() => page.doc.querySelector(".add-agent"), "New agent is offered");
  add.click();
  return waitFor(() => dialogs(page)[0], "the New agent dialog opens");
}

test("a closed dialog leaves a copy no one can reach, with what was typed, gone by 400 ms; the dialog itself goes at once", async () => {
  const page = await mount();
  try {
    const dialog = await openNewAgent(page);
    assert.ok(dialog.classList.contains("modal") && !dialog.classList.contains("modal-confirm"), "an ordinary dialog: it may rise as it enters");
    const field = dialog.querySelector('input[type="text"], input:not([type]), textarea');
    assert.ok(field, "the dialog has a field to type in");
    field.value = "Typed before closing";
    escape(page);
    await pause(0);
    assert.deepEqual(dialogs(page), [], "the dialog is gone in the close");
    const copy = ghost(page);
    assert.ok(copy, "a copy fades out instead");
    // Radix undoes its aria-hidden in an effect after the close (in Chromium, by the next frame:
    // motion-1b-check.mjs); here, it is undone while the copy is still showing.
    await waitFor(() => page.doc.querySelectorAll("[data-aria-hidden]").length === 0, "Radix's aria-hidden on the rest of the page is undone", 200);
    assert.ok(copy.isConnected, "the copy does not hold up that release");
    assert.equal(copy.getAttribute("aria-hidden"), "true");
    assert.ok(copy.hasAttribute("inert"));
    assert.equal(copy.parentElement, page.doc.body);
    assert.deepEqual([...copy.children].map((el) => el.classList.contains("modal") ? "box" : el.className), ["modal-overlay", "box"]);
    assert.equal(copy.querySelectorAll("[id], [role], [name], [for], [aria-modal], [aria-labelledby], [aria-describedby], [tabindex], [data-aria-hidden]").length, 0,
      "nothing in it is a dialog, a field's name, a label target, a tab stop or a mark of Radix's aria-hidden");
    assert.ok([...copy.querySelectorAll("input, textarea")].some((el) => el.value === "Typed before closing"), "it shows what was typed");
    await pause(450);
    assert.equal(ghost(page), null, "gone by the 400 ms fallback");
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("a direct Radix dialog (Jobs) leaves its copy in the same way", async () => {
  const page = await mount();
  try {
    const nav = await waitFor(() => page.doc.querySelector(".jobs-nav:not(:disabled)"), "Jobs can open");
    nav.click();
    await waitFor(() => dialogs(page).find((el) => el.classList.contains("jobs-dialog")), "the Jobs dialog opens");
    escape(page);
    await pause(0);
    assert.deepEqual(dialogs(page), []);
    const copy = ghost(page);
    assert.ok(copy?.querySelector(".modal.jobs-dialog"), "its copy, without the dialog's role or ids");
    assert.equal(copy.querySelectorAll("[id], [role]").length, 0);
    await pause(450);
    assert.equal(ghost(page), null);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("with reduced motion, or without Web Animations, a dialog simply goes", async () => {
  for (const options of [{ reduced: true }, { animations: false }]) {
    const page = await mount(options);
    try {
      await openNewAgent(page);
      escape(page);
      await pause(0);
      assert.deepEqual(dialogs(page), []);
      assert.equal(ghost(page), null, JSON.stringify(options));
      assert.deepEqual(page.errors, []);
    } finally { page.close(); }
  }
});

test("a confirmation removed while open (Disconnect, Cancel) leaves a copy too, and only fades", async () => {
  const page = await mount();
  try {
    const more = await waitFor(() => page.doc.querySelector(".agent-actions-button"), "an Agent's actions are offered");
    more.click();
    const item = await waitFor(() => [...page.doc.querySelectorAll('[role="menuitem"]')].find((el) => /^Disconnect/.test(el.textContent.trim())),
      "Disconnect is offered for a connected idle Codex Agent");
    item.click();
    const dialog = await waitFor(() => dialogs(page)[0], "the Disconnect confirmation opens");
    assert.ok(dialog.classList.contains("modal-confirm"), "a confirmation only fades in");
    [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "Cancel").click();
    await pause(0);
    assert.deepEqual(dialogs(page), [], "the dialog is removed with its Agent");
    const copy = ghost(page);
    assert.ok(copy, "its copy was taken as it unmounted, nodes still attached");
    assert.ok(copy.hasAttribute("data-confirm"), "and fades out without moving");
    await pause(450);
    assert.equal(ghost(page), null);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});

test("an Agent's confirmation keeps its entrance as it closes, and its copy only fades, as it was just before", async () => {
  const page = await mount();
  try {
    // Close, a confirmation from its opening: its mode clears as it closes.
    (await waitFor(() => page.doc.querySelector(".agent-close-button"), "Close agent is offered")).click();
    let dialog = await waitFor(() => dialogs(page)[0], "the Close confirmation opens");
    assert.ok(dialog.classList.contains("modal-confirm"), "a confirmation only fades in");
    // A class change as it closes would change its animation, which Radix waits for as an exit.
    const changed = [];
    new page.w.MutationObserver((records) => changed.push(...records.map((r) => r.target.className))).observe(dialog, { attributes: true, attributeFilter: ["class"] });
    escape(page);
    await pause(0);
    assert.deepEqual(dialogs(page), [], "the dialog is removed at once");
    assert.deepEqual(changed, [], "its class did not change as it closed");
    assert.ok(ghost(page)?.hasAttribute("data-confirm"), "its copy only fades");
    assert.match(ghost(page).querySelector("h2").textContent, /^Close Mori\?/, "and shows what was open");
    await pause(450);
    assert.equal(ghost(page), null);

    // Actions, from the Agent menu's Manage…, turned into Delete while open.
    (await waitFor(() => page.doc.querySelector(".agent-actions-button"), "an Agent's actions are offered")).click();
    (await waitFor(() => [...page.doc.querySelectorAll('[role="menuitem"]')].find((el) => /^Manage/.test(el.textContent.trim())), "Manage… is offered")).click();
    dialog = await waitFor(() => dialogs(page)[0], "the actions open");
    assert.ok(!dialog.classList.contains("modal-confirm"), "the actions rise in");
    (await waitFor(() => dialog.querySelector(".agent-action-card.danger-action"), "Delete is offered")).click();
    await waitFor(() => /^Delete Mori\?/.test(dialog.querySelector("h2")?.textContent || ""), "Delete asks");
    assert.ok(!dialog.classList.contains("modal-confirm"), "its entrance is kept: it would start again");
    escape(page);
    await pause(0);
    assert.deepEqual(dialogs(page), []);
    assert.ok(ghost(page)?.hasAttribute("data-confirm"), "Delete's copy only fades, though it entered as actions");
    assert.match(ghost(page).querySelector("h2").textContent, /^Delete Mori\?/);
    await pause(450);
    assert.deepEqual(page.errors, []);
  } finally { page.close(); }
});
