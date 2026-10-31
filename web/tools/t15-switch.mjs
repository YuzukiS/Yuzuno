// What survives a change of layout (T-15, acceptance 5): a folding phone
// opens and closes under the app, which crosses the phone breakpoint without
// reloading. The draft, where the conversation is read, and the focus should
// all be where they were, and a touch pointer should keep its larger rows at
// every size. Nothing is sent.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-switch.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const now = Date.now();
const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "idle", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
};
const agents = [agent, { ...agent, id: "b", name: "Dev 3 · public" }];
const detail = { agent, pending: [], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 40 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 3000 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮：折叠前后这里应当不动。` }] },
      { id: `r${i}`, type: "agentMessage", text: `第 ${i + 1} 轮的回复。`.repeat(12) },
    ],
  })) };
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const DRAFT = "折叠前写下的草稿，应当原样还在。";
const browser = await launchBrowser();
const context = await browser.newContext({
  viewport: { width: 951, height: 669 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
const page = await context.newPage();
const errors = [];
await page.addInitScript(() => {
  window.EventSource = class { close() {} };
  localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  addEventListener("DOMContentLoaded", () =>
    document.documentElement.style.setProperty("--safe-right", "84px"));
});
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
await page.waitForTimeout(500);

// The composer is a CodeMirror editor, so the draft is typed, not filled.
const composer = page.locator(".composer .cm-content").first();
await composer.click();
await composer.type(DRAFT, { delay: 4 });
// Read somewhere that is not the end, so the anchor has something to hold.
await page.evaluate(() => {
  const scroll = document.querySelector(".conversation-scroll");
  scroll.scrollTop = Math.round(scroll.scrollHeight * 0.45);
});
await page.waitForTimeout(400);

// The message the conversation itself would anchor on (ConversationWindow's
// ReadingAnchor picks the first one reaching the pane's top), and where it
// sits inside the pane. Which Turn is at the viewport's centre is NOT the
// judge: a shorter screen puts a different Turn there whatever the anchor
// does, so it is only reported.
const anchorRule = () => page.evaluate(() => {
  const pane = document.querySelector(".conversation-scroll");
  if (!pane) return null;
  const box = pane.getBoundingClientRect();
  const visible = [...pane.querySelectorAll("[data-item-id]")]
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.height > 0 && rect.bottom > box.top && rect.top < box.bottom);
  const pick = visible.find(({ rect }) => rect.top >= box.top) || visible[0];
  return pick ? { id: pick.element.dataset.itemId, within: Math.round(pick.rect.top - box.top) } : null;
});
/** Where one named message sits inside the pane now, or why it cannot be read. */
const offsetOf = (id) => page.evaluate((itemId) => {
  const pane = document.querySelector(".conversation-scroll");
  if (!pane) return { gone: "no pane" };
  const element = pane.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`);
  if (!element) return { gone: "unmounted" };
  const rect = element.getBoundingClientRect();
  if (rect.height <= 0) return { gone: "not drawn" };
  return { within: Math.round(rect.top - pane.getBoundingClientRect().top) };
}, id);

const state = () => page.evaluate(() => {
  const scroll = document.querySelector(".conversation-scroll");
  const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  const turn = el?.closest("[data-turn-id]")?.getAttribute("data-turn-id") ?? null;
  const rows = [...document.querySelectorAll(".turn-dock-stop")]
    .filter((b) => b.querySelector(".turn-dock-chip"))
    .map((b) => Math.round(b.getBoundingClientRect().height));
  return { draft: document.querySelector(".composer .cm-content")?.textContent ?? null,
    focus: document.activeElement?.tagName + "." + (document.activeElement?.className || "").split(" ")[0],
    top: Math.round(scroll?.scrollTop ?? -1),
    middleTurn: turn, numberRows: [...new Set(rows)], phone: document.querySelector(".app")?.classList.contains("phone") ?? null };
});

const before = await state();
const anchor = await anchorRule();
assert.ok(anchor?.id, "the conversation has a message to anchor on");
console.log("anchor      ", JSON.stringify(anchor));
console.log("start       ", JSON.stringify(before));

// Out to the folded size and back to the one we started at. Returning to the
// same geometry is what makes the offset comparable: the reflow has to undo
// exactly as much as it did.
const steps = [{ name: "folded 400x844", w: 400, h: 844 }, { name: "unfolded 951x669", w: 951, h: 669 }];
const seen = [];
for (const step of steps) {
  await page.setViewportSize({ width: step.w, height: step.h });
  await page.waitForTimeout(600);
  seen.push({ step: step.name, ...(await state()), anchor: await offsetOf(anchor.id) });
}
const after = seen[seen.length - 1];
for (const s of seen) console.log(s.step.padEnd(16), JSON.stringify(s));

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
check(seen.every((s) => s.draft === DRAFT), "the draft is unchanged at every size");
check(seen[0].phone === true && after.phone === false, "folding crosses the phone breakpoint and comes back");
// The judge: the same message, back at the same place inside the pane.
check(!after.anchor.gone, `the anchored message is still drawn after the round trip${after.anchor.gone ? ` (${after.anchor.gone})` : ""}`);
check(after.anchor.within !== undefined && Math.abs(after.anchor.within - anchor.within) <= 2,
  `it sits where it did, within 2px (${anchor.within} → ${after.anchor.within ?? "-"})`);
check(after.numberRows.length === 1 && after.numberRows[0] === 44,
  `touch keeps 44px Turn rows once open (${after.numberRows.join("/")})`);
check(after.focus === before.focus, `focus stays where it was (${before.focus} → ${after.focus})`);
console.log(`note: the Turn at the viewport's centre went ${before.middleTurn} → ${after.middleTurn}; a shorter`
  + " screen centres a different Turn whatever the anchor does, so this is reported, not judged.");

// A reader who moves the focus themselves keeps it: folding must not pull it
// back to the composer.
const elsewhere = page.locator(".conversation-header button, .app button").first();
await elsewhere.focus();
const moved = await page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
await page.setViewportSize({ width: 400, height: 844 });
await page.waitForTimeout(500);
await page.setViewportSize({ width: 951, height: 669 });
await page.waitForTimeout(600);
const kept = await page.evaluate(() => ({
  composer: !!document.activeElement?.closest?.(".composer"),
  where: document.activeElement?.className || document.activeElement?.tagName,
}));
check(!kept.composer, `a focus the reader moved is not taken back to the composer (left at ${moved}, now ${kept.where})`);

await browser.close();
check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
