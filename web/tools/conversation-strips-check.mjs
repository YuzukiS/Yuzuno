// T-51 PR 4 (T-19's CV:CW-11), in Chromium on a production build of the app with a synthetic Workspace
// and every API answered here (no Core, no Agent):
// - CV:CW-11: a message link opens the message with its source strip over the conversation's top, fading in,
//   the message placed clear below the strip, the conversation at its full height.
// - R1 f0b0a715: with Jobs and Turns docked, the strips line up with the request pin (between the docks; on a phone
//   across the whole conversation but its scrollbar). A link to the first Turn places it, its header too, clear
//   below the source strip.
// Under reduced motion the strips are there at once. Desktop 1280×860 and phone 390×844, each with normal and reduced
// motion. This check writes nothing. Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/conversation-strips-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { emptyHome, idleJobsBudget, noCiRuns, noConversationInputs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/conversation-strips");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], writes: [], unknownGets: [], measured: {} };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : ` ${JSON.stringify(detail).slice(0, 900)}`}`);
};

const WORKSPACE = "ws-conversation-strips";
const agent = { id: "a", name: "Mori", status: "idle", goal: "", cwd: "/fixture", model: "m", color: "sage", createdAt: "",
  updatedAt: "1", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, projectId: "p", harness: "codex",
  connectionState: "connected", threadId: "thread-a" };
// Enough Turns that the conversation scrolls well past its first screen.
const turns = Array.from({ length: 14 }, (_, i) => ({
  id: `t${i}`, status: "completed",
  items: [
    { id: `u${i}`, type: "userMessage", content: [{ type: "text", text: `Turn ${i + 1}: keep tidying the fixture notes.` }] },
    { id: `r${i}`, type: "agentMessage", phase: "final_answer",
      text: Array.from({ length: 5 }, (_, k) => `Step ${k + 1} of turn ${i + 1}: checked the panels, the queue and the notes.`).join("\n\n") },
  ],
}));
const usage = { revision: 1, status: "unknown", account: null, accountId: null,
  source: { generation: "fixture", label: "Codex", machineId: null, runtimeId: null },
  checkedAt: null, observedAt: null, ordinaryUsageAllowed: null, error: null, buckets: [] };
// Mori's finished Jobs, so the work dock shows (R1 f0b0a715: a phone keeps it hidden, its insets must not stay).
const resources = { cpuMillis: 1000, memoryMiB: 512, swapMiB: 0 };
const job = (id, name, status) => ({ id, requestId: id, name, taskRef: "T-51", agentId: "a", agent: { name: "Mori" },
  machine: { name: "Core host" }, status, reserved: false, reason: status === "failed" ? "exit-code" : null, resources,
  reservation: resources, cursor: 1, createdAt: "2026-11-05T10:00:00Z", startedAt: "2026-11-05T10:00:01Z",
  finishedAt: "2026-11-05T10:01:00Z", argv: ["/usr/bin/true"], cwd: "/fixture", env: {}, outputs: [] });
const jobs = { jobs: [job("j1", "the layout check", "failed"), job("j2", "unit tests", "succeeded")], liveJobs: [], hasMore: false, nextBefore: null };
const gets = {
  "/api/workspace": { workspace: { id: WORKSPACE }, agents: [agent], projects: [{ id: "p", name: "App", defaultDirs: {}, createdAt: "", updatedAt: "" }],
    runtime: { connected: true }, defaultCwd: "/fixture" },
  "/api/agents/a": { agent, pending: [], messageReceipts: [], artifacts: [], turns },
  "/api/agents/a/codex/usage": usage, "/api/agents/a/codex/mcp": { state: "observed", reason: "", generation: 1, more: 0, servers: [] },
  "/api/agents/a/conversation/inputs": noConversationInputs,
  "/api/backlog": { observedAt: "2026-11-05T00:00:00Z", agents: {} },
  "/api/models": { models: [] }, "/api/home": emptyHome, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
  "/api/jobs": jobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
async function serve(route) {
  const request = route.request();
  const url = new URL(request.url());
  const method = request.method();
  const path = url.pathname;
  if (path.startsWith("/api/")) {
    if (method === "GET") {
      if (gets[path] === undefined && !report.unknownGets.includes(path)) report.unknownGets.push(path);
      return route.fulfill({ json: gets[path] ?? {} });
    }
    report.writes.push(`${method} ${path}`);
    return route.fulfill({ status: 400, json: { error: "this check writes nothing" } });
  }
  const file = path === "/" ? "index.html" : path.slice(1);
  const full = resolve(dist, file);
  assert.ok(full.startsWith(dist + "/"));
  try {
    return route.fulfill({ body: await readFile(full), contentType: types[extname(file)] || "application/octet-stream" });
  } catch {
    return route.fulfill({ body: await readFile(join(dist, "index.html")), contentType: "text/html" });
  }
}

/** In the page from the first script: the live events, and what a strip plays and where the text in view is. */
function pageHelpers() {
  let id = 0;
  window.EventSource = class {
    constructor() {
      this.readyState = 0;
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        this.onopen?.({});
        this.onmessage?.({ data: JSON.stringify({ type: "reset", reason: "new" }), lastEventId: String(++id) });
      }, 0);
    }
    addEventListener() {}
    close() { this.readyState = 2; }
  };
  if (!sessionStorage.getItem("t51-seeded")) {
    sessionStorage.setItem("t51-seeded", "1");
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 16, palette: "garden" }));
  }
  window.__plays = (el) => !el ? null : el.getAnimations().filter((a) => a.playState === "running" || a.playState === "pending").map((a) => ({
    props: [...new Set((a.effect?.getKeyframes?.() ?? []).flatMap((k) => Object.keys(k))
      .filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p)))].sort().join("+"),
    duration: a.effect?.getTiming?.().duration ?? null,
  }));
  /** The conversation's height and where a row in view is, from the viewport's top. */
  window.__view = (itemId) => {
    const scroller = document.querySelector(".conversation-scroll");
    const row = document.querySelector(`[data-item-id="${itemId}"]`);
    return { scrollerHeight: scroller?.clientHeight ?? null, scrollTop: scroller?.scrollTop ?? null,
      rowTop: row ? row.getBoundingClientRect().top : null };
  };
  /** Records, from now, the first strip to show: what it plays then, and where it is. */
  window.__watchStrip = (text) => {
    const rec = { shown: null };
    const look = () => {
      if (rec.shown) return;
      const strip = [...document.querySelectorAll(".source-navigation")].find((el) => el.textContent.includes(text));
      if (!strip) return;
      const box = strip.getBoundingClientRect();
      rec.shown = { plays: window.__plays(strip), bottom: box.bottom, top: box.top,
        floats: getComputedStyle(strip.parentElement).position === "absolute" };
    };
    const observer = new MutationObserver(look);
    observer.observe(document.documentElement, { subtree: true, childList: true });
    window.__strip = { rec, stop: () => { observer.disconnect(); look(); return rec; } };
  };
}

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
const fadedSmall = (plays, reduced) => Array.isArray(plays) && (reduced ? plays.length === 0
  : plays.length === 1 && plays[0].props === "opacity" && plays[0].duration === 180);
const near = (a, b, tolerance = 0.5) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tolerance;

for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const motion = (normal, still) => (reduced ? still : normal);
  const measured = (report.measured[tag] = {});
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion, locale: "en-US",
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("http://yuzuno-t51-strips.test/**", serve);
  await page.addInitScript(pageHelpers);
  try {
    await page.goto("http://yuzuno-t51-strips.test/");
    await page.locator(".agent-row").first().waitFor({ timeout: 15_000 });
    if (run.phone && (await page.locator(".app.phone-list").count())) await page.locator(".agent-row").first().click();
    else if (!run.phone) await page.locator(".agent-row").first().click();
    await page.locator('[data-item-id="r13"]').waitFor({ timeout: 10_000 });

    // ---- CV:CW-11: a message link opens the message with its source strip.
    {
      let before = null;
      let strip = null;
      let placed = null;
      try {
        before = await page.evaluate(() => window.__view("r13"));
        await page.evaluate(() => window.__watchStrip("Linked message"));
        await page.evaluate((ws) => { location.hash = `#/message?w=${ws}&a=a&t=t9&i=r9`; }, WORKSPACE);
        await page.locator(".source-navigation", { hasText: "Linked message" }).waitFor({ timeout: 5000 });
        await page.waitForTimeout(500);
        strip = await page.evaluate(() => window.__strip.stop());
        placed = await page.evaluate(() => {
          const strip = [...document.querySelectorAll(".source-navigation")].find((el) => el.textContent.includes("Linked message"));
          const row = document.querySelector('[data-item-id="r9"]');
          return { stripBottom: strip?.getBoundingClientRect().bottom ?? null, rowTop: row?.getBoundingClientRect().top ?? null,
            scrollerHeight: document.querySelector(".conversation-scroll")?.clientHeight ?? null };
        });
      } catch (error) {
        strip = { error: String(error).slice(0, 200), strip };
      }
      measured.link = { before, strip, placed };
      ok(`${tag}: a message link opens the message with its source strip over the conversation's top ${motion("fading in over small", "with nothing playing")}, the message placed clear below it and the conversation at its full height`,
        !!strip?.shown && strip.shown.floats === true && fadedSmall(strip.shown.plays, reduced)
          && typeof placed?.rowTop === "number" && placed.rowTop >= placed.stripBottom - 0.5 && placed.rowTop - placed.stripBottom < 48
          && placed.scrollerHeight === before?.scrollerHeight, measured.link);
    }

    // ---- R1 f0b0a715 (1): the strips line up with the request pin, which shows only with a Turn running: an element
    // of its kind put in the same body for a moment says where its rules place it.
    {
      let lined = null;
      try {
        lined = await page.evaluate(() => {
          const body = document.querySelector(".conversation-body");
          const pin = document.createElement("details");
          pin.className = "current-turn-prompt";
          body.insertBefore(pin, body.querySelector(":scope > .conversation-scroll"));
          const p = pin.getBoundingClientRect();
          pin.remove();
          const s = document.querySelector(".conversation-strips")?.getBoundingClientRect();
          const b = body.getBoundingClientRect();
          return { work: body.matches(":has(> .work-dock:not(:empty))"), turns: body.matches(":has(.turn-dock)"),
            strips: s ? { left: s.left, right: s.right } : null, pin: { left: p.left, right: p.right },
            body: { left: b.left, right: b.right }, scrollbar: parseFloat(getComputedStyle(body).getPropertyValue("--conversation-scrollbar")) || 0 };
        });
      } catch (error) {
        lined = { error: String(error).slice(0, 200) };
      }
      measured.lined = lined;
      const whole = !run.phone || (near(lined?.strips?.left, lined?.body?.left) && near(lined?.strips?.right, lined.body.right - lined.scrollbar));
      ok(`${tag}: with Jobs and Turns docked, the strips line up with the request pin, ${run.phone ? "across the whole conversation but its scrollbar" : "between the docks"}`,
        !!lined?.work && !!lined?.turns && near(lined.strips?.left, lined.pin.left) && near(lined.strips?.right, lined.pin.right) && whole, lined);
    }

    // ---- A link to the first Turn itself: its top, the Turn's header above its first message, is what a strip covers.
    {
      let placed = null;
      try {
        await page.evaluate(() => { const s = document.querySelector(".conversation-scroll"); s.scrollTop = s.scrollHeight; });
        await page.waitForTimeout(300);
        await page.evaluate((ws) => { location.hash = `#/message?w=${ws}&a=a&t=t0`; }, WORKSPACE);
        await page.locator(".source-navigation", { hasText: "Linked message" }).waitFor({ timeout: 5000 });
        await page.waitForTimeout(500);
        placed = await page.evaluate(() => {
          const scroller = document.querySelector(".conversation-scroll").getBoundingClientRect();
          const row = document.getElementById("turn-t0")?.getBoundingClientRect();
          return { rowTop: row?.top ?? null, rowBottom: row?.bottom ?? null, scrollerBottom: scroller.bottom,
            focused: document.activeElement?.id ?? null,
            stripsBottom: document.querySelector(".conversation-strips")?.getBoundingClientRect().bottom
              ?? [...document.querySelectorAll(".source-navigation")].find((el) => el.textContent.includes("Linked message"))?.getBoundingClientRect().bottom ?? null };
        });
      } catch (error) {
        placed = { error: String(error).slice(0, 200), placed };
      }
      measured.first = placed;
      ok(`${tag}: a link to the conversation's first Turn places it, its header too, clear below the source strip`,
        typeof placed?.rowTop === "number" && typeof placed?.stripsBottom === "number" && placed.rowTop >= placed.stripsBottom - 0.5
          && placed.rowTop < placed.scrollerBottom && placed.focused === "turn-t0", placed);
    }
  } catch (error) {
    ok(`${tag}: the sequence ran to its end`, false, String(error).slice(0, 400));
  }
  await page.screenshot({ path: join(output, `${tag}-end.png`) }).catch(() => {});
  await context.close();
}
await browser.close();

ok("no page errors", report.errors.length === 0, report.errors);
ok("writes: none", report.writes.length === 0, report.writes);
await writeFile(join(output, "conversation-strips-check.json"), JSON.stringify(report, null, 2));
console.log(`${report.checks.length} passed, ${report.failures.length} failed; unanswered reads: ${JSON.stringify(report.unknownGets)}`);
if (report.failures.length) process.exit(1);
