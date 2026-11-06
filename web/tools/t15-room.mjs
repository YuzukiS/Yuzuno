// Does the layout follow the room the app has, or the window? (T-15, V6)
//
// `.app` carries the safe-area insets as padding, so a system control area at
// the side is not room the app can lay out in. Every responsive decision has
// to be a statement about that content box: whether the Agent rail is a
// column at all, how wide it starts, the least the conversation keeps, and
// whether there is room worth splitting for the Portal. Reading
// window.innerWidth instead counts the insets as usable and makes each of
// those decisions too generous by them — on the folded-out Duo, by 84px.
//
// The proof is the same window measured twice: once with an inset and once
// without. If the inset moves the decision, the decision is following the
// room. The insets here are injected (there is no Duo on this Mac), so the
// numbers are synthetic; what is being checked is the dependency, not a
// device reading.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-room.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const now = Date.now();
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
  turns: Array.from({ length: 8 }, (_, i) => ({
    id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 3000 + i * 60,
    items: [{ id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮` }] },
      { id: `r${i}`, type: "agentMessage", text: "正文".repeat(30) }],
  })),
};
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];

async function read({ width, height, inset }) {
  const context = await browser.newContext({
    viewport: { width, height }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript((right) => {
    window.EventSource = class { close() {} };
    if (right)
      addEventListener("DOMContentLoaded", () =>
        document.documentElement.style.setProperty("--safe-right", `${right}px`));
    if (!localStorage.getItem("yuzuno.appearance"))
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
    localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  }, inset || 0);
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents, runtime: { connected: true }, defaultCwd: "/work" } });
    if (/^\/api\/agents\/[ab]$/.test(path)) return route.fulfill({ json: detail });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: { jobs: [], liveJobs: [], hasMore: false, nextBefore: null } });
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
  page.on("pageerror", (error) => errors.push(`${width}x${height}+${inset || 0}: ${error.message}`));
  await page.goto("https://t15.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  const out = await page.evaluate(() => {
    const app = document.querySelector(".app");
    const style = getComputedStyle(app);
    const pad = (v) => parseFloat(v || "0") || 0;
    const room = app.clientWidth - pad(style.paddingLeft) - pad(style.paddingRight);
    const box = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().width) : 0;
    };
    // A collapsed rail still has to say who is in it and be pressable: the
    // acceptance asks for a list that collapses, not one that is kept wide
    // and says nothing.
    const rows = [...document.querySelectorAll(".app > .rail .agent-select")].map((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { w: Math.round(r.width), h: Math.round(r.height),
        named: ((el.getAttribute("aria-label") || el.textContent || "").trim().length > 0),
        titled: !!(el.getAttribute("title") || el.closest("[title]")),
        lands: at === el || el.contains(at) };
    });
    return { window: window.innerWidth, room: Math.round(room),
      rail: box(".app > .rail"), main: box(".app > .main-panel"),
      railWidthVar: style.getPropertyValue("--rail-width").trim(), rows };
  });
  await context.close();
  return out;
}

// A window that looks wide enough and is not: 760 with an 84px control area
// has 676 to lay out in, which is the other side of the 720 band.
const edge = { width: 760, height: 844 };
const withInset = await read({ ...edge, inset: 84 });
const without = await read({ ...edge, inset: 0 });
// The one this task is about.
const duo = await read({ width: 951, height: 669, inset: 84 });
// A window whose room is under the width at which a rail is a column at all.
const narrow = await read({ width: 580, height: 844, inset: 84 });

for (const [name, m] of [["760 window, 84px control area", withInset], ["760 window, no inset", without],
  ["951 window, 84px control area (the Duo fixture)", duo], ["580 window, 84px control area", narrow]]) {
  console.log(`\n--- ${name} ---`);
  console.log(`  window ${m.window}  room ${m.room}  ->  rail ${m.rail}  conversation ${m.main}  (--rail-width ${m.railWidthVar})`);
}
console.log("");

// The decision follows the room: the same window, with the insets taken out,
// lands on the other side of the band and gives a narrower rail.
check(withInset.room === withInset.window - 84,
  `the room is the window less the control area (${withInset.room} = ${withInset.window} - 84)`);
check(withInset.rail < without.rail,
  `the same 760px window starts a narrower rail once 84px of it is not the app's (${withInset.rail} vs ${without.rail})`);
check(withInset.main > 0 && without.main > 0, "and the conversation is laid out in both");
// Where the room runs short, the rail gives way to the conversation's own
// minimum rather than to a stub: at 496px of room the rail is as narrow as it
// may be and the conversation keeps the 320px that band allows it.
check(narrow.rail >= 150 && narrow.rail < withInset.rail,
  `at 496px of room the rail narrows but stays a column (${narrow.rail}px, under the 760px window's ${withInset.rail})`);
check(narrow.main >= 300,
  `and the conversation keeps its minimum rather than the rail keeping its width (${narrow.main}px)`);
// The case the task is about must not move: 951 with 84 is already past the
// band either way, so this change leaves the Duo fixture as it was.
check(duo.rail === 220, `the Duo fixture keeps the 220px rail it was measured with (${duo.rail})`);
check(duo.room === 867, `and the 867px of room behind every number in this task (${duo.room})`);
// Narrowed, the rail is still a list: it names who is in it and takes a
// press. (Its rows are drawn 18px tall and pressable over 52, by an ::after
// that takes the press — t15-touch.mjs reads that properly.)
console.log(`\n--- the narrowed rail at 580+84 ---`);
console.log(`  ${narrow.rows.length} rows: ${narrow.rows.map((r) => `${r.w}x${r.h}${r.named ? " named" : " UNNAMED"}${r.lands ? "" : " MISSED"}`).join(", ")}`);
check(narrow.rows.length === agents.length,
  `every Agent is still in the narrowed rail (${narrow.rows.length} of ${agents.length})`);
check(narrow.rows.every((r) => r.named),
  "and each one still says who it is, rather than being kept wide and silent");
check(narrow.rows.every((r) => r.lands), "and each one still takes a press");

check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
