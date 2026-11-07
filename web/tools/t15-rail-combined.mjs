// The rail row's long statuses on a 220px rail (T-15, #459 R8, P3).
//
// This task gave each row a second line: the name has line one, and the
// status, an executor's badge and the activity share line two. The status
// moved out of the name's button to get there, and the rules for its long
// forms stayed behind, written against the button:
//
//  - a combined wait ("Waiting · Job / CI · Check CI", "等待中 · Job / CI ·
//    核对 CI") and a Turn end not yet seen are marked `data-combined`, and
//    were meant to take a line of their own and wrap. Kept to one line by the
//    row's new `flex: none; white-space: nowrap`, they ran past the row's
//    right edge and pushed what follows out of sight;
//  - an executor's kind and state lost their pill;
//  - a Turn end not yet seen lost its colour.
//
// So this reads the rows a 220px rail has to hold. Since T-43 v4-2 the
// status is the row's island at the end of line two (its words in
// `data-status`, the badge gone): each island stays inside its row, whole;
// a combined wait is still marked `data-combined`; the executor's template
// and PR chips are held in the island, inside the row; and the unseen
// failed end is the island's failed state.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-rail-combined.mjs
// T15_LANG=zh-Hans reads the same rows in Chinese. That exact value: a
// language this does not know falls back to English and passes, which is the
// one way these checks can come back green without having run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const lang = process.env.T15_LANG || "en";
assert.ok(lang === "en" || lang === "zh-Hans", `T15_LANG must be en or zh-Hans, not ${lang}`);
const now = Date.now();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };

// The longest wait the row can say, as live-ci.ts words it.
const longWait = lang === "zh-Hans" ? "等待中 · Job / CI · 核对 CI" : "Waiting · Job / CI · Check CI";

const base = { status: "idle", harness: "claude", cwd: "/w", model: "m", color: "sage", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null };
const summary = { text: "正在量测中屏工作台两侧轴占用的宽度与高度", kind: "progress", source: "agent" };
const agents = [
  { ...base, id: "a", name: "Dev 8 · Mac / iOS" },
  // Idle, with a Job and a CI run waiting and a CI target to check.
  { ...base, id: "b", name: "Dev 3 · public", workSummary: summary },
  // A Turn that failed and that this device has not shown.
  { ...base, id: "u", name: "Dev 5 · public", lastSeq: 20, reviewedSeq: 9, lastTurnEnd: { seq: 20, outcome: "failed" } },
  // An executor, queued second in line, with the same waits.
  { ...base, id: "x", name: "T-7 · Reviewer", kind: "executor", projectId: "p1",
    executor: { state: "queued", agentId: "x", position: 2 } },
];
const projects = [{ id: "p1", name: "Yuzuno", defaultDirs: { local: "/w" }, createdAt: "", updatedAt: "" }];
const liveJobs = { agents: { b: { active: 2, unknown: 0 }, x: { active: 1, unknown: 0 } } };
const liveCi = { agents: { b: { running: 1, discovering: 0, check: 1 }, x: { running: 1, discovering: 0, check: 1 } } };
const turns = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 3000 + i * 60,
  items: [{ id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮` }] },
    { id: `r${i}`, type: "agentMessage", text: "回复。".repeat(30) }] }));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];
// The Duo's own screen, where the rail is 220px.
const context = await browser.newContext({ viewport: { width: 951, height: 669 }, reducedMotion: "reduce" });
const page = await context.newPage();
await page.addInitScript((lang) => {
  window.EventSource = class { constructor() { setTimeout(() => this.onopen?.(), 40); }
    addEventListener() {} close() {} };
  localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  localStorage.setItem("yuzuno.selected.ws", JSON.stringify("a"));
  if (lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
}, lang);
await page.route("**/*", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
  if (path === "/api/workspace")
    return route.fulfill({ json: { workspace: { id: "ws" }, projects, projectUsage: {}, agents, runtime: { connected: true }, defaultCwd: "/w" } });
  const one = path.match(/^\/api\/agents\/([a-z])$/);
  if (one) return route.fulfill({ json: { agent: agents.find((a) => a.id === one[1]), pending: [], messageReceipts: [], artifacts: [], turns } });
  if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
  if (path === "/api/jobs") return route.fulfill({ json: noJobs });
  if (path === "/api/jobs/live") return route.fulfill({ json: liveJobs });
  if (path === "/api/ci/live") return route.fulfill({ json: liveCi });
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
await page.waitForFunction((text) => [...document.querySelectorAll(".agent-island")].some((el) => (el.dataset.status || "").includes(text)),
  longWait, { timeout: 5_000 }).catch(() => {});
await page.waitForTimeout(400);

const seen = await page.evaluate(() => {
  const rail = document.querySelector(".rail")?.getBoundingClientRect();
  const rect = (r) => r && { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) };
  const row = (id) => {
    const el = document.querySelector(`.agent-row[data-agent-id="${id}"]`);
    if (!el) return null;
    const island = el.querySelector(".agent-island");
    const facts = el.querySelector(".executor-row-facts");
    const summary = el.querySelector(".agent-work-summary");
    const box = el.getBoundingClientRect();
    const inside = (r) => !!r && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
    const i = island?.getBoundingClientRect();
    const f = facts?.getBoundingClientRect();
    return {
      row: rect(box),
      status: island?.dataset.status ?? null,
      state: island?.dataset.state ?? null,
      combined: island?.dataset.combined === "true",
      island: rect(i),
      islandInside: inside(i),
      islandWhole: !!island && island.scrollWidth <= island.clientWidth + 1,
      facts: f ? { box: rect(f), inside: inside(f), inIsland: !!f.closest(".agent-island") } : null,
      summaryInside: summary ? inside(summary.getBoundingClientRect()) : null,
    };
  };
  return { rail: rail && Math.round(rail.width), b: row("b"), u: row("u"), x: row("x") };
});
console.log(`language: ${lang}\n${JSON.stringify(seen, null, 1)}`);

check(seen.rail === 220, `the rail is the 220px it is on this screen (${seen.rail})`);
check(!!seen.b && seen.b.status === longWait && seen.b.combined === true,
  `an Agent waiting on a Job and CI with a CI target to check says so on its island, marked combined (${JSON.stringify(seen.b?.status)})`);
check(!!seen.b && seen.b.islandInside && seen.b.islandWhole,
  `and its island is whole inside its row (${JSON.stringify(seen.b?.island)} in ${JSON.stringify(seen.b?.row)})`);
check(!!seen.b && seen.b.summaryInside !== false, `with the activity before it inside the row too (${seen.b?.summaryInside})`);
check(!!seen.u && seen.u.combined === true && seen.u.state === "failed" && seen.u.islandInside && seen.u.islandWhole,
  `a failed Turn end not yet seen is the island's failed state, whole inside its row (${seen.u?.state}, ${JSON.stringify(seen.u?.island)})`);
check(!!seen.x && seen.x.status === longWait && seen.x.islandInside && seen.x.islandWhole,
  `an executor with the same waits has them on its island, whole inside its row (${JSON.stringify(seen.x?.island)})`);
check(!!seen.x && seen.x.state === "queued", `and its island says it is queued (${seen.x?.state})`);
check(!seen.x?.facts || (seen.x.facts.inside && seen.x.facts.inIsland),
  `its template chip is held in its island, inside the row (${JSON.stringify(seen.x?.facts)})`);
check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
await context.close();
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
