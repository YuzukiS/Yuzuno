// The conversation head's two entries on a phone (T-15, #459 R8, P3).
//
// On a phone the Work activity entry opens the work drawer and the reading
// index entry the turns drawer: the drawers the phone already has. Two
// things were wrong with that.
//
//  - Both set the drawer directly, where the drawer's own buttons go through
//    the dock's motion (`dockMotion.choose`, T-19): opened or closed from the
//    head, a drawer appeared and went with no way in or out.
//  - The work drawer is the dock itself, and draws what Appearance lets it.
//    The entry counts everything — every review, every sub-agent — so with
//    reviews or sub-agents at 0 there and nothing else on the dock, the entry
//    said "1 need a look" and its press opened a drawer with nothing in it.
//
// So this reads both, on a phone: each entry's press goes in, and its second
// press out, the way the drawer's buttons do; and with the dock's reviews at
// 0 and one review that asked for changes, or its sub-agents at 0 and one
// that failed, the press opens that work rather than an empty drawer.
//   YUZUNO_UI_DIST=<isolated build> node tools/t15-phone-entries.mjs
// T15_LANG=zh-Hans reads the same screens in Chinese. That exact value: a
// language this does not know falls back to English and passes, which is the
// one way these checks can come back green without having run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const lang = process.env.T15_LANG || "en";
assert.ok(lang === "en" || lang === "zh-Hans", `T15_LANG must be en or zh-Hans, not ${lang}`);
const now = Date.now();
const iso = (ms) => new Date(now + ms).toISOString();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
const needsLook = lang === "zh-Hans" ? "1 个待查看" : "1 need a look";

const agent = {
  id: "a", name: "Dev 8 · Mac / iOS", status: "idle", harness: "claude", cwd: "/Users/yuzuki/work",
  model: "claude-opus-5", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 9, reviewedSeq: 9, connectionState: "connected", goal: "", projectId: null,
};
const res = { cpuMillis: 2000, memoryMiB: 2048 };
const runningJob = {
  id: "j1", name: "web-check 跨设备布局量测", status: "running", reason: null, agentId: "a",
  agent: { name: agent.name }, taskRef: "T-15", cwd: "/w", machine: { name: "owl-mac" },
  resources: res, reservation: res, exclusive: false, createdAt: iso(-300_000),
  startedAt: iso(-200_000), finishedAt: null, reserved: false, cursor: 1, requestId: "r1",
};
const askedForChanges = {
  id: "rev-1", taskId: "task-15", taskRef: "T-15", taskTitle: "Duo 与中屏工作台", linkId: "l",
  repository: "YuzukiS/Yuzuno", number: 459, url: "https://github.com/YuzukiS/Yuzuno/pull/459", round: 1,
  status: "completed", phase: "completed", conclusion: "changes_requested",
  requestedHarness: "claude", requestedModel: "claude-opus-5", actualHarness: "claude", actualModel: "claude-opus-5",
  baseSha: "b".repeat(40), headSha: "a".repeat(40), mergeBaseSha: "c".repeat(40),
  createdAt: iso(-5_000_000), finishedAt: iso(-4_400_000), error: null,
  requestedBy: { kind: "agent", id: "a", name: agent.name }, findingsCount: 2, outdated: false, cursor: 1,
};
const turns = (subAgent) => Array.from({ length: 8 }, (_, i) => ({
  id: `t${i}`, status: "completed", startedAt: Math.floor(now / 1000) - 800 + i * 60,
  items: [
    { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `第 ${i + 1} 轮：问题` }] },
    { id: `r${i}`, type: "agentMessage", text: `第 ${i + 1} 轮的回答。`.repeat(6) },
    ...(subAgent && i === 7
      ? [{ id: "sa", type: "claudeToolUse", name: "Task", status: "failed",
          subAgent: { taskId: "st", runId: "sr", type: "Explore", description: "子 Agent 的中屏量测", prompt: "量测" } }]
      : []),
  ],
}));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();

async function phone({ motion, dock, jobs = [], reviews = [], subAgent = false }) {
  const errors = [];
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: motion ? "no-preference" : "reduce" });
  const page = await context.newPage();
  await page.addInitScript(({ lang, dock }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden",
      ...(dock ? { dock } : {}) }));
    if (lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
    window.__opened = [];
    addEventListener("yuzuno:open-job", (event) => window.__opened.push(event.detail));
    // Every way the drawer is moved, in order: `data-phone-dock-way` is set
    // only by the dock's motion, for the length of a way in or out.
    window.__ways = [];
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.attributeName !== "data-phone-dock-way") continue;
        const way = r.target.getAttribute("data-phone-dock-way");
        if (way) window.__ways.push(`${r.target.getAttribute("data-phone-dock")}:${way}`);
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["data-phone-dock-way"] });
  }, { lang, dock });
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [], projectUsage: {}, agents: [agent], runtime: { connected: true }, defaultCwd: "/work" } });
    if (/^\/api\/agents\/a$/.test(path))
      return route.fulfill({ json: { agent, pending: [], messageReceipts: [], artifacts: [], turns: turns(subAgent) } });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: { ...noJobs, jobs } });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci") return route.fulfill({ json: noCiRuns });
    if (path === "/api/reviews") return route.fulfill({ json: { ...noReviews, reviews } });
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
  // The phone starts on the Agent list, which covers the conversation.
  await page.locator(".agent-select").first().click();
  await page.waitForTimeout(700);
  return { page, context, errors };
}
const state = (page) => page.evaluate(() => {
  const body = document.querySelector(".conversation-body");
  const dock = document.querySelector(".work-dock");
  const entry = document.querySelector(".work-activity-entry");
  return {
    phone: !!document.querySelector(".app.phone"),
    drawer: body?.getAttribute("data-phone-dock") ?? null,
    dockDrawn: !!dock && dock.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && dock.getBoundingClientRect().height > 0,
    dockItems: document.querySelectorAll(".work-dock .work-dock-item").length,
    entry: entry ? (entry.textContent || "").replace(/\s+/g, " ").trim() : null,
    opened: window.__opened.map((d) => ({ ...d })),
    ways: [...window.__ways],
  };
});

// --- both entries, with motion: in, and out again ---
{
  const { page, context, errors } = await phone({ motion: true, jobs: [runningJob] });
  const before = await state(page);
  console.log(`\n--- 390x844, a phone, motion on, one running Job ---\n  ${JSON.stringify(before)}`);
  check(before.phone && !!before.entry, `the phone layout, with the Work activity entry in the head (${before.phone}, ${JSON.stringify(before.entry)})`);
  const presses = [
    { what: "the Work activity entry", target: ".work-activity-entry", dock: "work" },
    { what: "the reading index entry", target: ".conversation-index-entry", dock: "turns" },
  ];
  for (const { what, target, dock } of presses) {
    await page.evaluate(() => { window.__ways.length = 0; });
    await page.locator(target).click();
    await page.waitForTimeout(80);
    const opening = await state(page);
    await page.waitForTimeout(700);
    const open = await state(page);
    await page.locator(target).click();
    await page.waitForTimeout(80);
    const closing = await state(page);
    await page.waitForTimeout(700);
    const closed = await state(page);
    console.log(`  ${what}: opening ${JSON.stringify(opening.ways)} → ${open.drawer}; closing ${JSON.stringify(closing.ways)} → ${closed.drawer}`);
    check(open.drawer === dock, `${what} opens the ${dock} drawer (${open.drawer})`);
    check(opening.ways.includes(`${dock}:in`),
      `${what} brings it in, as the drawer's own button does (${JSON.stringify(opening.ways)})`);
    check(closed.drawer === null, `and a second press closes it (${closed.drawer})`);
    check(closing.ways.includes(`${dock}:out`),
      `${what} takes it out the same way (${JSON.stringify(closing.ways)})`);
  }
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
  await context.close();
}

// --- the dock's reviews at 0, and one review that asked for changes ---
{
  const { page, context, errors } = await phone({ motion: false, dock: { jobs: 5, actions: 2, reviews: 0, subAgents: 5 }, reviews: [askedForChanges] });
  const before = await state(page);
  await page.locator(".work-activity-entry").click().catch(() => {});
  await page.waitForTimeout(700);
  const after = await state(page);
  console.log(`\n--- 390x844, a phone, reviews at 0, one review asked for changes ---\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`);
  check(before.dockItems === 0 && !!before.entry?.includes(needsLook),
    `the dock draws no review, and the entry counts the one that asked for changes (${before.dockItems}, ${JSON.stringify(before.entry)})`);
  check(!(after.drawer === "work" && after.dockItems === 0),
    `its press does not open a drawer with nothing in it (drawer ${after.drawer}, drawn ${after.dockDrawn}, ${after.dockItems} in it)`);
  check(after.opened.length === 1 && after.opened[0].involving === "a" && after.opened[0].source === "reviews",
    `it opens this Agent's reviews instead (${JSON.stringify(after.opened)})`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
  await context.close();
}

// --- the dock's sub-agents at 0, and one that failed ---
{
  const { page, context, errors } = await phone({ motion: false, dock: { jobs: 5, actions: 2, reviews: 2, subAgents: 0 }, subAgent: true });
  const before = await state(page);
  await page.locator(".work-activity-entry").click().catch(() => {});
  await page.waitForTimeout(700);
  const after = await state(page);
  const card = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[role='dialog']")].find((d) => d.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true }));
    return el ? (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) : null;
  });
  console.log(`\n--- 390x844, a phone, sub-agents at 0, one failed ---\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}\n  card: ${JSON.stringify(card)}`);
  check(before.dockItems === 0 && !!before.entry?.includes(needsLook),
    `the dock draws no sub-agent, and the entry counts the one that failed (${before.dockItems}, ${JSON.stringify(before.entry)})`);
  check(!(after.drawer === "work" && after.dockItems === 0),
    `its press does not open a drawer with nothing in it (drawer ${after.drawer}, drawn ${after.dockDrawn}, ${after.dockItems} in it)`);
  check(!!card, `it opens the sub-agents' card instead (${JSON.stringify(card)})`);
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors[0]}` : ""}`);
  await context.close();
}

await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
