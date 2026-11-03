// T-19 batch 1c, where a dialog stands (ST:D4): in Chromium on a production
// build of the app with a synthetic Workspace that is never written to. A
// dialog is centred across the window and hung max(8vh, 24px) below its top,
// so what it shows next only moves its bottom edge: an Agent's Actions turned
// into Delete, and /stop's terminals listed after its read (held, then
// answered), keep their top where it was. Settings, Jobs and the task board,
// of a fixed height, stay centred. Each dialog's place is recorded, with a
// screenshot; closed, its copy (DialogExitGhost.tsx) fades out where the box
// was, never from the centre. Run on the build before this batch too, where
// the top moves (the red). Reduced motion, a narrow window and a narrow one
// with a phone's insets (DevTools' override, as tools/safe-area-check.mjs) are
// run. The Portal's service confirmation is not opened here. Emulated insets
// are not an iPhone, and Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-1c-anchor-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-1c-anchor");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], notShown: [], places: {}, switches: {}, ghosts: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};
const agent = { id: "a", name: "Mori", goal: "", cwd: "/w", model: "m", color: "green", status: "idle", createdAt: "", updatedAt: "",
  unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex", connectionState: "connected" };
const terminal = (n) => ({ processId: String(4100 + n), itemId: `call-${n}`, command: `npm run watch:${n}`, cwd: "/w", inRunningTurn: false });
const listing = { state: "listed", reason: "listed", detail: null, generation: 4, threadId: "thread-a", terminals: [1, 2, 3, 4].map(terminal), complete: true };
const gets = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs, "/api/jobs": noJobs, "/api/ci": noCiRuns,
  "/api/reviews": noReviews,
  "/api/workspace": { workspace: { id: "fixture" }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/w" },
  "/api/agents/a": { agent, pending: [], artifacts: [], turns: [] },
};
// The task board's reads are POSTs (CollaborationBoard.tsx `call`); none changes anything.
const boardReads = {
  task_list: () => ({ tasks: [], hasMore: false, counts: {} }),
  peer_read: () => ({ messages: [], hasMore: false }),
  peers_list: () => ({ peers: [] }),
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
// /stop's read waits for the check to let it answer.
let releaseTerminals = null;
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    const method = request.method();
    const operation = url.pathname.startsWith("/api/collaboration/") ? url.pathname.slice("/api/collaboration/".length) : null;
    if (method === "POST" && operation && boardReads[operation]) return route.fulfill({ json: boardReads[operation]() });
    if (method === "GET" && url.pathname === "/api/agents/a/codex/terminals") {
      await new Promise((go) => { releaseTerminals = go; });
      return route.fulfill({ json: listing });
    }
    if (method === "GET") {
      const hit = Object.keys(gets).sort((a, b) => b.length - a.length).find((p) => url.pathname === p || url.pathname.startsWith(p + "/"));
      return route.fulfill({ json: hit ? gets[hit] : {} });
    }
    report.writes.push(`${method} ${url.pathname}`);
    return route.fulfill({ status: 404, json: { error: "not in this check's fixture" } });
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const path = resolve(dist, file);
  assert.ok(path.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(path), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}

/** In the page: the open dialog's box (not its copy), as laid out, and the window. */
function pageHelpers() {
  window.__box = () => {
    const box = [...document.querySelectorAll(".modal")].find((el) => !el.closest(".dialog-exit-ghost"));
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return { top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10, height: Math.round(r.height * 10) / 10,
      centreX: Math.round((r.left + r.width / 2) * 10) / 10, vw: innerWidth, vh: innerHeight, title: box.querySelector("h2")?.textContent ?? null,
      plays: box.getAnimations().map((a) => a.animationName) };
  };
  /** The copy's box in every frame from the next Escape, for `span` ms. */
  window.__watchGhost = (span = 500) => {
    window.__ghostFrames = [];
    const start = (event) => {
      if (event.key !== "Escape") return;
      removeEventListener("keydown", start, true);
      const t0 = performance.now();
      const frame = () => {
        const copy = document.querySelector(".dialog-exit-ghost > .modal");
        const r = copy?.getBoundingClientRect();
        window.__ghostFrames.push({ t: Math.round(performance.now() - t0), ghost: !!copy,
          top: r ? Math.round(r.top * 10) / 10 : null, centreX: r ? Math.round((r.left + r.width / 2) * 10) / 10 : null,
          translate: copy ? getComputedStyle(copy).translate : null });
        if (performance.now() - t0 < span) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    addEventListener("keydown", start, true);
  };
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "narrow", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "narrow-insets", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true,
    insets: { top: 47, right: 0, bottom: 34, left: 0 } },
];
const near = (a, b, within = 1) => typeof a === "number" && Math.abs(a - b) <= within;
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  const insets = run.insets || { top: 0, right: 0, bottom: 0, left: 0 };
  if (run.insets) await (await context.newCDPSession(page)).send("Emulation.setSafeAreaInsetsOverride", { insets });
  // Hung max(8vh, 24px) below the safe area's top, and at least 24 px clear of its bottom.
  const anchorTop = (vh) => insets.top + Math.max(0.08 * vh, 24);
  const bottomGap = (box) => box.vh - insets.bottom - box.bottom;
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  await page.addInitScript(() => { window.EventSource = class { addEventListener() {} close() {} }; });
  await page.goto("http://yuzuno-motion.test/");
  await page.locator(".agent-row, .phone-dock-button").first().waitFor();
  await page.waitForTimeout(400);
  const visible = (selector, hasText) => page.locator(selector, hasText ? { hasText } : {}).filter({ visible: true }).first();
  const openBy = (selector) => async () => {
    const el = visible(selector);
    if (!(await el.count()) || !(await el.isEnabled())) return false;
    await el.click();
    return true;
  };
  const agentMenu = (item) => async () => {
    const row = visible(".agent-row");
    if (await row.count()) await row.hover();
    const more = visible(".agent-actions-button");
    if (!(await more.count())) return false;
    await more.click();
    const choice = page.locator('.agent-actions-menu [role="menuitem"]', { hasText: item }).first();
    if (!(await choice.count())) {
      await page.keyboard.press("Escape");
      return false;
    }
    await choice.click();
    return true;
  };
  const command = (text) => async () => {
    const input = visible("[data-composer-input]");
    if (!(await input.count())) return false;
    await input.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(text);
    const send = visible(".send-button");
    if (!(await send.count()) || !(await send.isEnabled())) return false;
    await send.click();
    return true;
  };
  const settle = async () => {
    await page.locator(".modal").first().waitFor({ timeout: 3000 });
    await page.waitForTimeout(reduced ? 150 : 400);
    return page.evaluate(() => window.__box());
  };
  const shot = (name) => !reduced && page.screenshot({ path: join(output, `${tag}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`) });

  /** Where a dialog stands once open: hung from near the top, or for a fixed panel centred. */
  async function place(name, open, { centred = false, close = () => page.keyboard.press("Escape") } = {}) {
    if (!(await open())) return report.notShown.push(`${tag}: ${name}`);
    const box = await settle();
    report.places[`${tag}: ${name}`] = box;
    await shot(name);
    if (!box) {
      ok(`${tag}: ${name} opens`, false, null);
    } else if (centred) {
      ok(`${tag}: ${name}, of a fixed height, stays centred in the safe area (top ${box.top}, bottom gap ${Math.round(bottomGap(box))})`,
        near(box.top, insets.top + (box.vh - insets.top - insets.bottom - box.height) / 2) && near(box.centreX, box.vw / 2), box);
    } else {
      const top = anchorTop(box.vh);
      ok(`${tag}: ${name} is centred across and hung at ${top} px (top ${box.top}, bottom gap ${Math.round(bottomGap(box))} ≥ 24 above the safe area's edge)`,
        near(box.top, top) && near(box.centreX, box.vw / 2) && bottomGap(box) >= 23.5, box);
    }
    await close();
    await page.waitForTimeout(450);
  }

  /** A dialog whose content changes while open keeps its top; then its copy fades where it was. */
  async function switching(name, open, change, { after }) {
    if (!(await open())) return report.notShown.push(`${tag}: ${name}`);
    const before = await settle();
    await shot(`${name} before`);
    await change();
    await page.locator(".modal h2, .modal h3", { hasText: after }).first().waitFor({ timeout: 3000 });
    await page.waitForTimeout(reduced ? 150 : 400);
    const now = await page.evaluate(() => window.__box());
    await shot(`${name} after`);
    report.switches[`${tag}: ${name}`] = { before, after: now };
    ok(`${tag}: ${name}: its height changes (${before?.height} → ${now?.height} px) and its top stays (${before?.top} → ${now?.top})`,
      !!before && !!now && Math.abs(now.height - before.height) > 8 && near(now.top, before.top) && near(now.top, anchorTop(now.vh)), { before, after: now });
    await page.evaluate(() => window.__watchGhost(500));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    const frames = await page.evaluate(() => window.__ghostFrames);
    report.ghosts[`${tag}: ${name}`] = frames;
    const shown = frames.filter((f) => f.ghost);
    if (reduced) ok(`${tag}: ${name}: closed under reduced motion, no copy is made`, frames.length > 0 && !shown.length, frames.slice(0, 2));
    else
      ok(`${tag}: ${name}: closed, its copy fades out where the box was (top ${now?.top}; the copy from ${shown[0]?.top} to ${shown.at(-1)?.top}, sinking at most 4 px), never from the centre`,
        shown.length > 0 && shown.every((f) => f.top >= now.top - 0.5 && f.top <= now.top + 4.5 && near(f.centreX, now.centreX)), shown.slice(0, 3));
  }

  // Hung from near the top.
  await place("New agent", openBy(".add-agent"));
  await place("Search", openBy(".conversation-search-trigger"));
  await place("Agent settings", agentMenu(/^Agent settings/));
  await place("Disconnect", agentMenu(/^Disconnect/));
  await place("Close agent", openBy(".agent-close-button"));
  await place("Changes (/changes)", command("/changes"));
  // Fixed panels, centred.
  await place("Settings", openBy(".workspace-settings"), { centred: true });
  await place("Jobs", openBy(".jobs-nav"), { centred: true });
  await place("Tasks", openBy(".collab-nav"), { centred: true });

  // Actions turned into Delete while open (AgentManagement), from the Agent menu's Manage….
  await switching("Actions then Delete", agentMenu(/^Manage/),
    () => page.locator(".modal .agent-action-card.danger-action").first().click(), { after: /^Delete Mori\?/ });
  // /stop (CodexTerminals): listing, then the four terminals once its read answers.
  releaseTerminals = null;
  await switching("Stop terminals (/stop)", async () => {
    if (!(await command("/stop")())) return false;
    await page.locator(".modal.codex-terminals").first().waitFor({ timeout: 3000 });
    return true;
  }, async () => {
    for (let i = 0; i < 50 && !releaseTerminals; i++) await page.waitForTimeout(20);
    releaseTerminals?.();
  }, { after: /^Running now/ });
  const opened = Object.keys({ ...report.places, ...report.switches }).filter((w) => w.startsWith(`${tag}: `));
  ok(`${tag}: dialogs were opened (${opened.length})`, opened.length >= 2, opened);
  await context.close();
}
await browser.close();

// Under reduced motion each dialog stands where it does without it.
for (const [where, box] of Object.entries(report.places).filter(([w]) => w.startsWith("desktop-reduced: "))) {
  const moving = report.places[where.replace("desktop-reduced: ", "desktop: ")];
  ok(`${where.replace("desktop-reduced: ", "")}: under reduced motion it stands where it does with motion, playing nothing`,
    !!moving && near(box.top, moving.top) && near(box.height, moving.height) && !box.plays.length, { reduced: box, moving });
}
ok("nothing was written to the synthetic Workspace (Disconnect, Close, Delete and Stop were only closed)", report.writes.length === 0, report.writes);
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-1c-anchor-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors, notShown: report.notShown, writes: report.writes }));
process.exit(report.passed ? 0 : 1);
