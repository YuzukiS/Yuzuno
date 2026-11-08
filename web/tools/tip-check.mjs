// The app's one tooltip in Chromium (YN-44): every tip drawn as the Work
// dock's CI run card was, and behaving the same everywhere. Against an
// isolated build with a fixture Core (nothing real is reached):
//  - the look: each tip's surface, hairline, radius, padding, shadow and
//    text size are the reference card's (work-dock.css before YN-44: the
//    raised surface, 1px line, 9px radius, 8 × 11 px, `0 8px 26px` palette
//    shadow, 12px text at the default size), compared as computed styles
//    with a probe drawn from those reference rules in the same page;
//  - the Agent row's card in five states and two staying pills, the Work
//    dock's CI run card and Interrupt's tip, screenshotted beside what they
//    describe, in English and Chinese, light and dark, Yuzu and Garden;
//  - the behaviour: nothing before 300 ms of rest, then the tip; at once on
//    a keyboard focus; Escape closes it; leaving closes it; wholly on screen;
//  - a phone: nothing for a finger passing, a touch held on the ring shows
//    the card under the row, and the next tap only closes it.
// TIP_SHOTS names a folder for the screenshots and summary.json.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const shots = process.env.TIP_SHOTS ? resolve(process.env.TIP_SHOTS) : null;
if (shots) await mkdir(shots, { recursive: true });
let failed = 0;
const results = [];
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${what}`);
  results.push({ ok: !!ok, what });
  if (!ok) failed++;
};

// A fixture workspace: one Project with a lead, a standing Agent at work
// (its conversation open, with Jobs and CI runs in its dock), and executors
// in each state the ring card says. Every name is synthetic.
const now = Date.now();
const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
const project = { id: "p", name: "Widgets", defaultDirs: {}, createdAt: "", updatedAt: "" };
const agent = (id, extra = {}) => ({
  id, name: `Agent ${id}`, goal: "", cwd: "/synthetic/widgets", model: "m", color: "sage", status: "idle", harness: "codex",
  createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p",
  connectionState: "connected", ...extra,
});
const executor = (id, name, state, task, template, extra = {}, lifecycle = {}) => agent(id, {
  name, kind: "executor",
  executor: { state, agentId: id, dispatcher: { kind: "agent", id: "l", name: "Project Lead" }, task, template,
    dispatchedAt: at(72), since: at(5), ...lifecycle },
  ...extra,
});
const prTemplate = { id: "pr", label: "PR template" };
const agents = [
  agent("l", { name: "Project Lead", kind: "lead", unreadCount: 4, lastTurnEnd: { at: at(26) },
    workSummary: { kind: "progress", source: "agent", text: "S3 merged; S4 next" } }),
  agent("a", { name: "Builder", status: "working", harness: "claude",
    workSummary: { kind: "progress", source: "agent", text: "Measuring the layout on three screens" } }),
  executor("k", "Builder 3", "running", { id: "PX-21", title: "Export device preferences as a JSON file", shortName: "Export device prefs" }, prTemplate,
    { status: "working", workSummary: { kind: "progress", source: "agent", text: "Writing the import round-trip test" } }),
  executor("w", "Writer 2", "running", { id: "PX-30", title: "Draft the release notes grouped by feature", shortName: "Release notes" }, { id: "docs", label: "Docs template" },
    { status: "waiting", pendingCount: 1, workSummary: { kind: "pending", source: "runtime", text: "Approve the outline before I write the sections", requestId: "q1" } },
    { dispatcher: { kind: "user" } }),
  executor("f", "Builder 5", "failed", { id: "PX-33", title: "Move settings into the new store", shortName: "Settings store" }, prTemplate,
    { closedAt: at(5) }, { reason: "Worktree already checked out at .worktrees/px-33" }),
  executor("v", "Builder 2", "delivering", { id: "PX-18", title: "Fix dark-mode contrast on cards", shortName: "Dark mode contrast" }, prTemplate,
    { workSummary: { kind: "result", source: "agent", text: "Opened PR #52 for review" } }, { since: at(40) }),
  executor("q", "Builder 6", "queued", { id: "PX-35", title: "Tidy the CSS tokens", shortName: "Tidy CSS tokens" }, prTemplate,
    {}, { position: 2, dispatcher: { kind: "user" }, dispatchedAt: at(4) }),
];
const live = {
  executors: {
    k: { pr: { number: 48, url: "https://example.invalid/pr/48", state: "draft", headSha: "c".repeat(40), ci: "pending",
      reviews: { approved: 1, changesRequested: false, running: false } } },
    v: { pr: { number: 52, url: "https://example.invalid/pr/52", state: "open", headSha: "b".repeat(40), ci: "success",
      reviews: { approved: 0, changesRequested: false, running: false } } },
  },
};
const home = {
  generatedAt: at(0), order: ["p"],
  needsYou: [{ kind: "approval", projectId: "p", agentId: "w", agentName: "Writer 2", requestId: "q1", title: "Approve the outline before I write the sections", since: at(12.5) }],
  projects: [{ project: { id: "p", name: "Widgets" }, agents: { working: 2, idle: 3, waiting: 1, error: 1, offline: 0, total: 7 },
    errors: [], pending: [], jobs: [], unseen: 0, missing: [], brief: { version: 1, history: [], sections: [] } }],
};
const res = { cpuMillis: 2000, memoryMiB: 2048 };
const job = (i, status) => ({
  id: `j${i}`, name: `layout-check-${i}`, status, reason: null, agentId: "a", agent: { name: "Builder" }, taskRef: "PX-21",
  cwd: "/synthetic/widgets", machine: { name: "lab-box" }, resources: res, reservation: res, exclusive: false,
  createdAt: at(10), startedAt: at(9), finishedAt: status === "running" ? null : at(2), reserved: false, cursor: i, requestId: `r${i}`,
});
const jobs = [job(0, "running"), job(1, "succeeded")];
const ci = {
  runs: [{ id: "c0", name: "CI", repository: "acme/widgets", runId: "1000", attempt: "1", headSha: "aa1ed34a9f", status: "in_progress",
    rawStatus: "in_progress", conclusion: null, url: "https://example.invalid/", createdAt: at(8), startedAt: at(7), updatedAt: at(1),
    observedAt: at(0.5), cursor: 1, runWatched: true, agentId: "a" }],
  subscriptions: [], hasMore: false, nextBefore: null,
};
const detail = (id) => ({ agent: agents.find((x) => x.id === id), pending: [], messageReceipts: [], artifacts: [],
  turns: [{ id: "t1", status: "inProgress", startedAt: Math.floor(now / 1000) - 120,
    items: [{ id: "u1", type: "userMessage", content: [{ type: "text", text: "Measure the layout" }] }] }] });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };

const browser = await launchBrowser();
const errors = [];

const open = async ({ name, phone, theme, palette, lang }) => {
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    hasTouch: phone, isMobile: phone, deviceScaleFactor: 2, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.addInitScript(({ theme, palette, lang, phone }) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette }));
    if (lang !== "en") localStorage.setItem("yuzuno.language", JSON.stringify({ language: lang }));
    if (!phone) localStorage.setItem("yuzuno.selected", JSON.stringify("a"));
  }, { theme, palette, lang, phone });
  await page.route("**/*", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") return route.fulfill({ json: { ok: true } });
    if (path === "/api/workspace")
      return route.fulfill({ json: { workspace: { id: "ws" }, projects: [project], projectUsage: {}, agents, runtime: { connected: true }, defaultCwd: "/synthetic" } });
    const one = path.match(/^\/api\/agents\/(\w)$/);
    if (one) return route.fulfill({ json: detail(one[1]) });
    if (path === "/api/home") return route.fulfill({ json: home });
    if (path === "/api/executors/live") return route.fulfill({ json: live });
    if (path.endsWith("/task_list")) return route.fulfill({ json: { tasks: [], counts: {}, hasMore: false } });
    if (path === "/api/updates") return route.fulfill({ json: unmanagedUpdates });
    if (path === "/api/jobs") return route.fulfill({ json: { jobs, liveJobs: [], hasMore: false, nextBefore: null } });
    if (path === "/api/jobs/live") return route.fulfill({ json: noLiveJobs });
    if (path === "/api/jobs/budget") return route.fulfill({ json: idleJobsBudget });
    if (path === "/api/ci") return route.fulfill({ json: ci });
    if (path === "/api/reviews") return route.fulfill({ json: noReviews });
    if (path === "/api/machines") return route.fulfill({ json: { machines: [] } });
    if (path === "/api/catchup") return route.fulfill({ json: { items: [], generatedAt: "", source: "records", coverage: { fromSeq: 0, toSeq: 0 } } });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    try { return route.fulfill({ body: await readFile(file), contentType: types[extname(file)] }); }
    catch { return route.fulfill({ status: 404, body: "" }); }
  });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto("https://tips.test/");
  await page.locator(".app").waitFor({ timeout: 10_000 });
  await page.locator('.agent-list article[data-agent-id="k"]').waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  return { context, page };
};

/** The tip showing, with its box and its computed look beside a probe drawn
 * from the reference card's own rules (work-dock.css before YN-44). */
const readTip = (page) => page.evaluate(() => {
  const tip = document.querySelector('.tip[role="tooltip"]');
  if (!tip) return null;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-999px;top:0;padding:8px 11px;border:1px solid var(--line);border-radius:9px;"
    + "background:var(--surface-raised);box-shadow:0 8px 26px var(--palette-shadow, #00000020);color:var(--ink);"
    + "font-size:calc(9px + var(--font-adjust, 3px));line-height:1.45";
  document.body.append(probe);
  const look = (el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`, radius: s.borderTopLeftRadius,
      padding: s.padding, shadow: s.boxShadow, color: s.color, fontSize: s.fontSize, lineHeight: s.lineHeight };
  };
  const reference = look(probe);
  probe.remove();
  const r = tip.getBoundingClientRect();
  const lines = [...tip.children].flatMap((c) => (c.classList.contains("agent-card-facts") ? [...c.children] : [c]))
    .map((c) => c.textContent.replace(/\s+/g, " ").trim()).filter(Boolean);
  return {
    box: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) },
    inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
    side: tip.dataset.side, lang: tip.getAttribute("lang"), lines, look: look(tip), reference,
  };
});
const sameLook = (tip) => tip && Object.keys(tip.reference).every((k) => tip.look[k] === tip.reference[k]);
const lookDiff = (tip) => (tip ? Object.keys(tip.reference).filter((k) => tip.look[k] !== tip.reference[k])
  .map((k) => `${k}: ${tip.look[k]} vs ${tip.reference[k]}`).join("; ") : "no tip");

const shot = async (page, file, anchor, tip) => {
  if (!shots || !tip) return;
  const a = await anchor.boundingBox();
  const left = Math.max(0, Math.min(a.x, tip.box.left) - 12), top = Math.max(0, Math.min(a.y, tip.box.top) - 12);
  const right = Math.max(a.x + a.width, tip.box.right) + 12, bottom = Math.max(a.y + a.height, tip.box.bottom) + 12;
  const size = page.viewportSize();
  await page.screenshot({ path: join(shots, file), clip: { x: left, y: top, width: Math.min(size.width, right) - left, height: Math.min(size.height, bottom) - top } });
};

const summary = [];
/** Leave every trigger, and wait out the moment in which the next one would
 * open at once (TIP_SKIP_MS, 400 ms). */
const away = async (page) => {
  await page.mouse.move(700, 420);
  await page.waitForTimeout(600);
};

/** Rest the pointer on `anchor`: nothing at 150 ms, the tip by 600 ms. */
const rest = async (page, anchor, what) => {
  await away(page);
  await anchor.hover();
  await page.waitForTimeout(150);
  const early = await readTip(page);
  await page.waitForTimeout(450);
  const tip = await readTip(page);
  check(!early && !!tip, `${what}: no tip at 150 ms, its tip by 600 ms`);
  return tip;
};

const desktop = [
  { name: "yuzu-dark-en", theme: "dark", palette: "yuzu", lang: "en" },
  { name: "yuzu-light-en", theme: "light", palette: "yuzu", lang: "en" },
  { name: "garden-light-zh", theme: "light", palette: "garden", lang: "zh-Hans" },
  { name: "garden-dark-zh", theme: "dark", palette: "garden", lang: "zh-Hans" },
];
for (const screen of desktop) {
  console.log(`\n--- ${screen.name}, 1280 × 800, a mouse ---`);
  const { context, page } = await open({ ...screen, phone: false });
  for (const id of ["k", "w", "f", "v", "q", "l"]) {
    const row = page.locator(`.agent-list article[data-agent-id="${id}"]`);
    const tip = await rest(page, row.locator(".agent-line-one"), `${screen.name} row ${id}`);
    const box = await row.boundingBox();
    check(!!tip && tip.inViewport && tip.side === "right" && tip.box.left >= box.x + box.width,
      `${screen.name} row ${id}: the card beside the row, wholly on screen (${JSON.stringify(tip?.box)})`);
    check(sameLook(tip), `${screen.name} row ${id}: the reference card's look (${lookDiff(tip) || "same"})`);
    check(!!tip && !tip.lines.some((l) => /^(Ring|Row|点环|点行)\b|Click|Open the conversation|打开会话/.test(l)),
      `${screen.name} row ${id}: no line about where a click goes`);
    await shot(page, `${screen.name}-row-${id}.png`, row, tip);
    summary.push({ screen: screen.name, what: `row ${id}`, lines: tip?.lines, look: tip?.look });
    await away(page);
    check(!(await readTip(page)), `${screen.name} row ${id}: leaving closes it`);
  }
  // From one row straight to the next: the next card at once.
  await away(page);
  await page.locator('.agent-list article[data-agent-id="k"] .agent-line-one').hover();
  await page.waitForTimeout(500);
  await page.locator('.agent-list article[data-agent-id="w"] .agent-line-one').hover();
  await page.waitForTimeout(80);
  const next = await readTip(page);
  check(!!next && next.lines[0] === "Release notes",
    `${screen.name}: moving straight to the next row shows its card at once (${next?.lines?.[0]})`);
  await away(page);
  // The keyboard: at once, and Escape closes it.
  await page.keyboard.press("Shift");
  const started = Date.now();
  await page.locator('.agent-list article[data-agent-id="k"] .agent-select').focus();
  await page.waitForTimeout(60);
  const focused = await readTip(page);
  check(!!focused && Date.now() - started < 250, `${screen.name}: a keyboard focus opens the card at once`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(100);
  check(!(await readTip(page)), `${screen.name}: Escape closes it`);
  await page.locator('.agent-list article[data-agent-id="k"] .agent-select').blur();
  // The Work dock's CI run, the reference itself, and Interrupt.
  const dock = page.locator(".work-dock-item").first();
  if (await dock.count()) {
    const tip = await rest(page, dock, `${screen.name} Work dock item`);
    check(sameLook(tip), `${screen.name} Work dock item: the reference card's look (${lookDiff(tip) || "same"})`);
    await shot(page, `${screen.name}-dock.png`, dock, tip);
    summary.push({ screen: screen.name, what: "dock", lines: tip?.lines, look: tip?.look });
  } else check(false, `${screen.name}: a Work dock item to rest on`);
  const stop = page.locator(".interrupt-button");
  if (await stop.count()) {
    const tip = await rest(page, stop, `${screen.name} Interrupt`);
    check(!!tip && tip.lines[0]?.endsWith("Esc"), `${screen.name} Interrupt: its name and Esc (${tip?.lines?.join(" | ")})`);
    check(sameLook(tip), `${screen.name} Interrupt: the reference card's look (${lookDiff(tip) || "same"})`);
    check(await stop.getAttribute("aria-label") !== null, `${screen.name} Interrupt keeps an accessible name`);
    await shot(page, `${screen.name}-interrupt.png`, stop, tip);
    summary.push({ screen: screen.name, what: "interrupt", lines: tip?.lines });
  } else {
    check(false, `${screen.name}: the Interrupt button to rest on (${await page.evaluate(() => document.querySelector(".composer-send-actions")?.outerHTML.slice(0, 200) ?? "no composer actions")})`);
    if (shots) await page.screenshot({ path: join(shots, `${screen.name}-page.png`) });
  }
  await context.close();
}

/** A finger held still at the middle of `locator`, through Chromium's own touch input. */
const hold = async (page, locator, ms) => {
  const b = await locator.boundingBox();
  const point = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
};

for (const screen of [
  { name: "phone-yuzu-dark-zh", theme: "dark", palette: "yuzu", lang: "zh-Hans" },
  { name: "phone-garden-light-en", theme: "light", palette: "garden", lang: "en" },
]) {
  console.log(`\n--- ${screen.name}, 390 × 844, a finger ---`);
  const { context, page } = await open({ ...screen, phone: true });
  const row = page.locator('.agent-list article[data-agent-id="k"]');
  if (!(await row.isVisible())) {
    check(false, `${screen.name}: the rail is shown`);
    await context.close();
    continue;
  }
  // A finger passing over the rail opens nothing.
  await hold(page, page.locator('.agent-list article[data-agent-id="q"] .agent-line-one'), 60);
  await page.waitForTimeout(450);
  check(!(await readTip(page)), `${screen.name}: a tap shows no tip`);
  await page.goto("https://tips.test/");
  await page.locator('.agent-list article[data-agent-id="k"]').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  // Held on the ring: the card, under the row, wholly on screen; not the actions.
  await hold(page, row.locator(".island-ringbox"), 700);
  await page.waitForTimeout(250);
  const tip = await readTip(page);
  const box = await row.boundingBox();
  check(!!tip && tip.inViewport && tip.box.top >= box.y + box.height - 2,
    `${screen.name}: a touch held on the ring shows the card under the row (${JSON.stringify(tip?.box)})`);
  check(!(await page.locator('[role="menu"]').count()), `${screen.name}: not the actions`);
  check(sameLook(tip), `${screen.name}: the reference card's look (${lookDiff(tip) || "same"})`);
  await shot(page, `${screen.name}-held.png`, row, tip);
  summary.push({ screen: screen.name, what: "held ring", lines: tip?.lines });
  // The next tap only closes it: the row tapped does not open.
  const other = page.locator('.agent-list article[data-agent-id="l"] .agent-line-one');
  await hold(page, other, 40);
  await page.waitForTimeout(400);
  check(!(await readTip(page)), `${screen.name}: the next tap closes the card`);
  check(await page.locator('.agent-list article[data-agent-id="l"]').isVisible() && !(await page.locator('.agent-list article[data-agent-id="l"] .agent-select[aria-current="true"]').count()),
    `${screen.name}: and opens nothing`);
  await context.close();
}

await browser.close();
check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(" / ")}` : ""}`);
if (shots) await writeFile(join(shots, "summary.json"), JSON.stringify({ results, summary }, null, 2) + "\n");
console.log(`\n${failed ? `${failed} FAILED` : "all passed"} (${results.length} checks)`);
process.exit(failed ? 1 : 0);
