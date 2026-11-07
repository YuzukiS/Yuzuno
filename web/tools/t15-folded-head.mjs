// The head of a folded screen, and what sits under it (T-15).
//
// This task put two things in the conversation's heading — the work entry and
// the reading index — and let the name wrap so that it keeps a width to press
// instead of collapsing to nothing. Every other check of that head reads it
// at 951 or 820, where there is room. Folded there is not: at 320 the three
// could not share a row, the heading took three of them, and the header went
// from 55px to 139px. The request pin hangs at the header's foot, so it came
// down with it and covered a pending approval's Allow once and Decline — with
// the conversation already at its end, where no amount of scrolling brings
// them back (found by phone-conversation-check, which is not run by CI).
//
// So: the head of a folded screen is read here too. What is asserted is the
// mechanism, because that is what this task changed and what it can hold to
// — the two entries share a row rather than taking one each, a name too long
// for the head still keeps a width to press, and nothing the conversation is
// showing is covered by the pin. The header's own height is printed, not
// asserted: what a folded head may cost is Dev 7's to say, not this check's.
//
// Both a short name and one too long to fit are read, since the wrap this
// task added is there for the long one and the rows are counted on the short.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-folded-head.mjs
// T15_LANG=zh-Hans reads the same screen in Chinese. That exact value: a
// language this does not know falls back to English and passes, which is
// the one way these checks can come back green without having run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const lang = process.env.T15_LANG || "en";
assert.ok(lang === "en" || lang === "zh-Hans", `T15_LANG must be en or zh-Hans, not ${lang}`);
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

// A long name, because a name the head cannot fit is the reason the heading
// wraps at all; and a working Agent, so the request pin is there to cover
// something.
const NAMES = { short: "Sora", long: "Dev 8 · Mac / iOS · 折叠屏工作台与阅读空间" };
let name = NAMES.short;
const agent = {
  id: "a", get name() { return name; }, status: "working", harness: "claude",
  cwd: "/Users/yuzuki/work", model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 1, lastSeq: 12, reviewedSeq: 12, connectionState: "connected",
  goal: "", projectId: null,
};
const res = { cpuMillis: 2000, memoryMiB: 2048 };
// Something for the work entry to count, so it is at its widest.
const jobs = [0, 1, 2].map((i) => ({
  id: `j${i}`, name: `web-check-${i}`, status: i === 0 ? "failed" : "running", reason: null,
  agentId: "a", agent: { name: NAMES.short }, taskRef: "T-15", cwd: "/w", machine: { name: "owl-mac" },
  resources: res, reservation: res, exclusive: false, createdAt: iso(-600_000), startedAt: iso(-500_000),
  finishedAt: i === 0 ? iso(-100_000) : null, reserved: false, cursor: i, requestId: `r${i}`,
}));
const approval = {
  id: "req-1", agentId: "a", method: "item/commandExecution/requestApproval", createdAt: iso(-3_000),
  params: { command: "node tools/t15-folded-head.mjs --output=/fixture/report.json", cwd: "/fixture",
    reason: "Run the check that writes its report", itemId: "cmd-1", turnId: "t11",
    availableDecisions: ["accept", "decline", "cancel"] },
};
const detail = {
  agent, pending: [approval], messageReceipts: [], artifacts: [],
  turns: Array.from({ length: 12 }, (_, i) => ({
    id: `t${i}`, status: i === 11 ? "inProgress" : "completed",
    startedAt: Math.floor(now / 1000) - 3000 + i * 60,
    items: [
      { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮：接着看下一部分。` }] },
      { id: `r${i}`, type: "agentMessage", text: "正文内容".repeat(20) },
    ],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];

const open = async (width, height) => {
  const context = await browser.newContext({
    viewport: { width, height }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript((lang) => {
    window.EventSource = class { constructor() { this.readyState = 1; setTimeout(() => this.onopen?.(), 40); }
      addEventListener() {} close() {} };
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    if (lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  }, lang);
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents: [agent], runtime: { connected: true }, defaultCwd: "/work" } });
    if (/^\/api\/agents\/a$/.test(path)) return route.fulfill({ json: detail });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: { jobs, liveJobs: [], hasMore: false, nextBefore: null } });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci") return route.fulfill({ json: { runs: [], subscriptions: [], hasMore: false, nextBefore: null } });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/catchup") return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  page.on("pageerror", (e) => errors.push(`${width}x${height}: ${e.message}`));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  // The phone layout opens on the Agent list; the conversation is behind it.
  if (await page.locator(".app.phone-list").count())
    await page.locator(".agent-list .agent-select").first().click();
  await page.locator(".conversation-scroll").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  // At the end of the conversation, which is where the approval is and where
  // nothing can be scrolled out from under the pin.
  await page.evaluate(() => { const p = document.querySelector(".conversation-scroll"); p.scrollTop = p.scrollHeight; });
  await page.waitForTimeout(700);
  return { context, page };
};

for (const [which, width, height] of [
  ["short", 320, 844], ["short", 375, 812], ["short", 390, 844],
  ["long", 320, 844], ["long", 375, 812]]) {
  name = NAMES[which];
  const { context, page } = await open(width, height);
  const seen = await page.evaluate(() => {
    const box = (sel) => { const el = document.querySelector(".main-panel " + sel) || document.querySelector(sel);
      if (!el) return null; const r = el.getBoundingClientRect();
      return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) }; };
    const heading = document.querySelector(".conversation-heading");
    // How many rows the heading took, by the distinct tops of what is in it.
    const kids = heading ? [...heading.children].filter((c) => c.getBoundingClientRect().height > 0) : [];
    // Rows by the bands they occupy, not by their tops: on one row a small
    // label and a 40px entry are centred together and start at different
    // heights, which counted as two.
    const rows = (() => {
      const bands = [];
      for (const c of kids.map((c) => c.getBoundingClientRect()).sort((a, b) => a.top - b.top)) {
        const last = bands[bands.length - 1];
        if (last && c.top < last.bottom - 1) last.bottom = Math.max(last.bottom, c.bottom);
        else bands.push({ top: c.top, bottom: c.bottom });
      }
      return bands.length;
    })();
    const rowOf = (sel) => { const el = heading?.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top) : null; };
    const name1 = heading?.querySelector("h1");
    const nameBox = name1?.getBoundingClientRect();
    const nameAt = nameBox ? document.elementFromPoint(Math.round(nameBox.left + nameBox.width / 2), Math.round(nameBox.top + nameBox.height / 2)) : null;
    const pin = document.querySelector(".main-panel .current-turn-prompt");
    const pinBox = pin?.getBoundingClientRect();
    // Everything the conversation is showing that answers a press, and what
    // actually takes that press at its middle.
    const covered = [];
    const pressable = [];
    const pane = document.querySelector(".main-panel .conversation-scroll").getBoundingClientRect();
    for (const el of document.querySelectorAll(".main-panel .conversation-scroll button, .main-panel .conversation-scroll summary, .main-panel .conversation-scroll a[href]")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.bottom <= pane.top || r.top >= pane.bottom) continue;
      const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
      const at = document.elementFromPoint(x, y);
      const label = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24);
      pressable.push(label);
      if (at && !(at === el || el.contains(at) || el.contains(at) || at.contains(el))) {
        const who = at.closest(".current-turn-prompt") ? "current-turn-prompt"
          : `${at.tagName.toLowerCase()}.${(at.className || "").toString().split(" ")[0]}`;
        covered.push({ label, by: who, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
      }
    }
    const target = (sel) => { const el = document.querySelector(".main-panel " + sel); if (!el) return null;
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return { w: Math.round(r.width), h: Math.round(r.height), own: !!at && (at === el || el.contains(at)) }; };
    return { header: box(".conversation-header"), heading: box(".conversation-heading"), rows,
      shareRow: rowOf(".work-activity-entry") !== null && rowOf(".work-activity-entry") === rowOf(".conversation-index-entry"),
      name: nameBox ? { w: Math.round(nameBox.width), h: Math.round(nameBox.height),
        own: !!nameAt && (nameAt === name1 || name1.contains(nameAt)) } : null,
      pin: pinBox ? { t: Math.round(pinBox.top), b: Math.round(pinBox.bottom) } : null,
      work: target(".work-activity-entry"), index: target(".conversation-index-entry"),
      pressable: pressable.length, labels: pressable, covered,
      approval: (() => { const c = document.querySelector(".main-panel .approval-card, .main-panel .permission-request, .main-panel [class*=approval]");
        if (!c) return null; const r = c.getBoundingClientRect();
        return { cls: c.className, t: Math.round(r.top), b: Math.round(r.bottom),
          rows: c.querySelectorAll(".button-row button").length }; })(),
      byPin: covered.filter((c) => c.by === "current-turn-prompt") };
  });
  const who = `${which} name at ${width}`;
  console.log(`\n--- ${width}x${height}, a finger, a ${which} name ---`);
  console.log(`  header ${seen.header?.h}px, heading ${seen.heading?.h}px in ${seen.rows} row(s), pin ${JSON.stringify(seen.pin)}`);
  console.log(`  ${seen.pressable} pressable in view; work ${JSON.stringify(seen.work)}, index ${JSON.stringify(seen.index)}`);
  console.log(`  name ${JSON.stringify(seen.name)}, entries share a row: ${seen.shareRow}`);
  if (seen.covered.length) console.log(`  covered: ${JSON.stringify(seen.covered)}`);

  check(!!seen.pin, `${who}: a working Agent's request is pinned, so there is something to be under`);
  if (which === "short")
    check(seen.rows <= 2,
      `${who}: the heading is the name's row and the two entries', no more (${seen.rows}; they share: ${seen.shareRow})`);
  else {
    check(seen.rows <= 3, `${who}: a name of its own, then the rest, and no more rows than that (${seen.rows})`);
    // The wrap is here for this: a name the head cannot fit used to collapse
    // to nothing, and there was no hit on it at all (Dev 7, 0 of 9).
    check(!!seen.name && seen.name.w >= 72, `${who}: the name keeps a width to press (${seen.name?.w}px)`);
    check(!!seen.name?.own, `${who}: and takes its own press`);
  }
  check(seen.pressable > 0, `${who}: the conversation is showing things to press (${seen.pressable})`);
  check(seen.byPin.length === 0,
    `${who}: and the pin covers none of them at the end of the conversation${seen.byPin.length ? `: ${JSON.stringify(seen.byPin)}` : ""}`);
  check(seen.covered.length === 0,
    `${who}: nor does anything else${seen.covered.length ? `: ${JSON.stringify(seen.covered)}` : ""}`);
  for (const [what, t] of [["the work entry", seen.work], ["the reading index", seen.index]]) {
    check(!!t && Math.min(t.w, t.h) >= 40, `${who}: ${what} is a finger's worth (${t ? `${t.w}x${t.h}` : "missing"})`);
    check(!!t?.own, `${who}: and ${what} takes its own press`);
  }
  await context.close();
}

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
