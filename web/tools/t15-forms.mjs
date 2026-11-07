// What survives the change of form this task introduced (T-15, acceptance 5:
// "切换前后实际行为测试").
//
// t15-switch.mjs already crosses the phone breakpoint. This is the other
// switch, the one V4 and V5 added: a roomy screen and a short one are two
// forms of the same workbench — the head is 122px against 99, and the bottom
// bar is a bar against a panel out of the grid. Crossing between them is
// CSS-driven reflow with no remount, which is the mechanism; this check is
// the proof. Both directions, by resizing the window.
//
// Three things must come through untouched: the draft as typed, the turn the
// reader was on, and the focused control. The turn is judged by its own
// element still being in the pane — not by a pixel offset, which a reflow is
// entitled to change — and the control by node identity, so focus landing on
// a different button that merely looks the same is a failure.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-forms.mjs
// T15_LANG=zh-Hans reads the same screen in Chinese. That exact value: a
// language this does not know falls back to English and passes, which is
// the one way these checks can come back green without having run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const now = Date.now();
const DRAFT = "草稿要原样留下 · this draft must come through the switch unchanged";
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "idle", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
};
const agents = [agent, { ...agent, id: "b", name: "Dev 3 · public" }];
const detail = {
  agent, pending: [], messageReceipts: [], artifacts: [],
  // Enough to scroll, so there is a place in the conversation to be kept.
  turns: Array.from({ length: 30 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 6000 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮：问题` }] },
      { id: `r${i}`, type: "agentMessage", text: `第 ${i + 1} 轮的回答。`.repeat(14) },
    ],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];
// A mouse, so the two forms are told apart by the screen's height and not by
// the pointer: with a coarse pointer the short form applies at every size and
// there is no switch to test.
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 }, hasTouch: false, isMobile: false, reducedMotion: "reduce" });
const page = await context.newPage();
await page.addInitScript((lang) => {
  window.EventSource = class { close() {} };
  if (!localStorage.getItem("yuzuno.appearance"))
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  if (lang && lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
  localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
}, process.env.T15_LANG || "en");
await page.route("**/*", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
  if (path === "/api/workspace")
    return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents, runtime: { connected: true }, defaultCwd: "/work" } });
  if (/^\/api\/agents\/[ab]$/.test(path)) return route.fulfill({ json: detail });
  if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
  if (path === "/api/jobs") return route.fulfill({ json: noJobs });
  if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
  if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
  if (path === "/api/ci") return route.fulfill({ json: noCiRuns });
  if (path === "/api/reviews") return route.fulfill({ json: noReviews });
  if (path === "/api/catchup") return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
  if (path.startsWith("/api/")) return route.fulfill({ json: {} });
  const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
  try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
  catch { return route.fulfill({ status: 404, body: "" }); }
});
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("https://t15.test/");
await page.locator(".app").waitFor({ timeout: 10_000 });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(600);

// --- set up what has to survive ---

// The composer is a CodeMirror editor, so the draft is typed, not filled.
const composer = page.locator(".composer .cm-content").first();
await composer.click();
await composer.type(DRAFT, { delay: 3 });

// Read somewhere that is not the end, and name the turn that is being read.
await page.evaluate(() => {
  const pane = document.querySelector(".conversation-scroll");
  pane.scrollTop = Math.round(pane.scrollHeight * 0.45);
});
await page.waitForTimeout(400);
const reading = await page.evaluate(() => {
  const pane = document.querySelector(".conversation-scroll");
  const box = pane.getBoundingClientRect();
  // The first message whose top is inside the pane: the one the reader's eye
  // is on, and the one ConversationWindow's anchor would hold.
  const seen = [...pane.querySelectorAll("[data-item-id]")]
    .map((el) => ({ id: el.dataset.itemId, rect: el.getBoundingClientRect() }))
    .filter((m) => m.rect.height > 0 && m.rect.bottom > box.top && m.rect.top < box.bottom);
  const pick = seen.find((m) => m.rect.top >= box.top) || seen[0];
  return pick ? { id: pick.id, within: Math.round(pick.rect.top - box.top), onScreen: seen.length } : null;
});
assert.ok(reading?.id, "the conversation has a message to be read");

// Focus a control that stands in both forms, and mark the node itself: an
// expando lives exactly as long as this DOM node does, so focus landing on a
// different button that looks the same does not pass.
const focused = await page.evaluate(() => {
  const el = document.querySelector(".conversation-header .conversation-action");
  if (!el) return null;
  el.__t15mark = "kept";
  el.focus();
  return { what: el.className.toString().split(/\s+/).slice(0, 2).join("."),
    name: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24),
    isActive: document.activeElement === el };
});
assert.ok(focused?.isActive, "a control in the head can be focused");

/** The form as it stands, plus the three things that must not change. */
const look = (id) => page.evaluate((itemId) => {
  const h = (sel) => {
    const el = document.querySelector(sel);
    return el ? Math.round(el.getBoundingClientRect().height) : 0;
  };
  const pane = document.querySelector(".conversation-scroll");
  const box = pane?.getBoundingClientRect();
  const el = pane?.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`);
  const rect = el?.getBoundingClientRect();
  const active = document.activeElement;
  return {
    // What form this is: the head's height and whether the bar is in the grid.
    chrome: h(".toolbar") + h(".conversation-header"),
    bar: h(".statusbar"),
    draft: document.querySelector(".composer .cm-content")?.textContent ?? null,
    // In view, judged by the element and the pane it sits in.
    reading: !el ? { gone: "unmounted" }
      : !rect?.height ? { gone: "not drawn" }
      : { inView: rect.bottom > box.top && rect.top < box.bottom,
          within: Math.round(rect.top - box.top) },
    focus: { same: active?.__t15mark === "kept",
      what: active ? `${active.tagName.toLowerCase()}.${(active.className || "").toString().split(/\s+/)[0]}` : "none" },
  };
}, id);

const roomy = await look(reading.id);
console.log(`\nreading   ${JSON.stringify(reading)}`);
console.log(`focused   ${JSON.stringify(focused)}`);
console.log(`roomy     ${JSON.stringify(roomy)}`);

// --- to the short form and back ---
const steps = [
  { name: "short 951x669", w: 951, h: 669 },
  { name: "roomy 1400x900", w: 1400, h: 900 },
];
const seen = [];
for (const step of steps) {
  await page.setViewportSize({ width: step.w, height: step.h });
  await page.waitForTimeout(700);
  seen.push({ step: step.name, ...(await look(reading.id)) });
}
for (const s of seen) console.log(`${s.step.padEnd(16)} ${JSON.stringify(s)}`);
const [short, back] = seen;

// The switch has to be real, or nothing below means anything.
check(short.chrome < roomy.chrome - 15 && short.bar === 0,
  `the form really changes (head ${roomy.chrome} -> ${short.chrome}, bar ${roomy.bar} -> ${short.bar})`);
check(back.chrome === roomy.chrome && back.bar === roomy.bar,
  `and comes back (head ${back.chrome}, bar ${back.bar})`);

// 1. The draft, as typed.
check(short.draft === DRAFT, "the draft comes through the switch unchanged");
check(back.draft === DRAFT, "and comes back unchanged");

// 2. The turn being read, by its own element.
check(!short.reading.gone && short.reading.inView,
  `the turn being read is still in the pane in the short form (${JSON.stringify(short.reading)})`);
check(!back.reading.gone && back.reading.inView,
  `and still there on the way back (${JSON.stringify(back.reading)})`);

// 3. The focused control, by node identity.
check(short.focus.same, `focus stays on the same control (${short.focus.what})`);
check(back.focus.same, `and is still on it after the round trip (${back.focus.what})`);

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await context.close();
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
