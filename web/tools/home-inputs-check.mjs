// YN-16 S1 in Chromium, every API answered here (no Core, no daily
// configuration), through the production build, in English and Simplified
// Chinese, light and dark, at 1440 px and on a phone (390 px, touch):
//  - a Group of inputs named as a card's visual (small, wide, large) draws
//    live on the card: every control at least 40 px, inside its frame,
//    nothing cut or wider than the window;
//  - the card's stepper, slider, switch and segments set its variables by
//    pointer, touch and keyboard, and the blocks that read them show and
//    hide on the card; none of them opens the report, and dragging the
//    slider on a phone moves it without scrolling Home;
//  - a focused control shows its focus ring;
//  - the report page starts from the section's own values, not the card's,
//    and an input in its summary shows a block in a later part of the page;
//    back on Home, the card keeps the reader's values;
//  - nothing is sent but reads, and nothing is asked of another host.
// Pattern: YN-7's home-desk-cards-check.mjs.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node --experimental-strip-types tools/home-inputs-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";
import { checkBriefSection } from "../src/intelligent-ui/brief-contract.ts";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const report = { task: "YN-16 S1", runs: [], posts: [], unexpected: [], errors: [] };
const HOST = "yuzuno-inputs.test";
const PROJECT = "p-in";
const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const agents = [{ id: "l", name: "lead-1", harness: "claude", model: "opus", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0,
  lastSeq: 40, reviewedSeq: 40, goal: "", connectionState: "connected", status: "idle", cwd: "/w/kitchen", projectId: PROJECT }];
const projects = [{ id: PROJECT, name: "kitchen-notes", defaultDirs: {}, createdAt: "", updatedAt: "" }];
const owner = { agentId: "l", name: "lead-1", state: "active" };
const node = (type, props, children, visible) => ({ type, props, ...(children ? { children } : {}), ...(visible ? { visible } : {}) });
const md = (text, visible) => node("Markdown", { text }, undefined, visible);
let id = 300;
/** A section as Core keeps it: first accepted by the real contract. */
const section = (key, title, body) => {
  const checked = checkBriefSection({ key, kind: "report", title, body });
  return { id: id++, key, kind: "report", title, version: 3, owner, updatedAt: at(20), updatedTurnId: "t1",
    body: checked.body, attachments: [], refs: {}, seen: null, history: false };
};
const sections = [
  // Wide: a stepper with a slider, a switch, and a block for 6 or more; the page has more.
  section("scones", "Scones for the guests", { root: "body", elements: {
    body: node("BriefBody", { summary: { lead: "lead", visual: "try", size: "wide" } }, ["lead", "try", "method"]),
    lead: md("The amounts scale with the guests; the vegan version swaps the butter."),
    try: node("Group", {}, ["guests", "vegan", "many"]),
    guests: node("NumberInput", { name: "guests", label: "Guests", value: 4, min: 1, max: 12, unit: "people", control: "both" }),
    vegan: node("Switch", { name: "vegan", label: "Vegan", value: false, detail: "Olive oil for butter" }),
    many: md("Bake on two trays.", { $state: "/guests", gte: 6 }),
    method: node("Group", { title: "Method" }, ["butter", "oil"]),
    butter: md("Rub the cold butter into the flour.", { $state: "/vegan", not: true }),
    oil: md("Stir the olive oil into the flour.", { $state: "/vegan" }),
  } }),
  // Small: a choice between two views of the numbers.
  section("split", "Which validation split", { root: "body", elements: {
    body: node("BriefBody", { summary: { lead: "lead", visual: "compare", size: "small" } }, ["lead", "compare"]),
    lead: md("The larger split halves the gap between seeds."),
    compare: node("Group", {}, ["which", "current", "larger"]),
    which: node("Segmented", { name: "which", label: "Split", value: "current", options: [{ value: "current", label: "Current" }, { value: "larger", label: "Larger" }] }),
    current: node("Metrics", { items: [{ label: "Seed gap", value: 0.031 }] }, undefined, { $state: "/which", eq: "current" }),
    larger: node("Metrics", { items: [{ label: "Seed gap", value: 0.015 }] }, undefined, { $state: "/which", eq: "larger" }),
  } }),
  // Large: a slider alone with a prefix, three segments and a switch.
  section("budget", "A monthly budget", { root: "body", elements: {
    body: node("BriefBody", { summary: { lead: "lead", visual: "plan", size: "large" } }, ["lead", "plan"]),
    lead: md("Rent is the largest share; the rest follows from it."),
    plan: node("Group", {}, ["rent", "city", "share", "over"]),
    rent: node("NumberInput", { name: "rent", label: "Rent", value: 1200, min: 400, max: 3000, step: 50, prefix: "€", control: "slider" }),
    city: node("Segmented", { name: "city", label: "City", value: 2, options: [{ value: 1, label: "Lisbon" }, { value: 2, label: "Berlin" }, { value: 3, label: "Paris" }] }),
    share: node("Switch", { name: "share", label: "Shared flat", value: true }),
    over: md("Over a third of a typical income.", { $state: "/rent", gt: 1500 }),
  } }),
];
const home = () => ({
  generatedAt: at(0), order: [PROJECT], needsYou: [],
  projects: [{ project: { id: PROJECT, name: "kitchen-notes" }, agents: { working: 0, idle: 1, waiting: 0, error: 0, offline: 0, total: 1 },
    errors: [], pending: [], jobs: [], unseen: sections.length, missing: [], brief: { version: 9, history: [], sections } }],
});
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const words = { en: { decrease: "Decrease Guests", on: "On", off: "Off" }, "zh-Hans": { decrease: "减少Guests", on: "开", off: "关" } };

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const runs = [];
for (const language of ["en", "zh-Hans"])
  for (const theme of ["light", "dark"])
    for (const [name, viewport, phone] of [["1440", { width: 1440, height: 1000 }, false], ["phone-390", { width: 390, height: 844 }, true]])
      runs.push({ name: `${language}-${theme}-${name}`, language, theme, phone, viewport });
try {
  for (const run of runs) await check(run);
} finally {
  await browser.close();
  await writeFile(join(output, "home-inputs-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.deepEqual(report.unexpected, [], "nothing was asked of another host");
assert.deepEqual(report.errors, [], "no page errors");
assert.deepEqual(report.posts, [], "nothing but reads");
console.log(`home-inputs-check: ${report.runs.length} runs, ${report.runs.reduce((n, r) => n + r.checks.length, 0)} checks`);

async function check(run) {
  const result = { run: run.name, checks: [], shots: [] };
  report.runs.push(result);
  const pass = (name, extra = {}) => {
    result.checks.push({ name, ...extra });
    console.log(`PASS [${run.name}] ${name}`);
  };
  const w = words[run.language];
  const context = await browser.newContext({
    viewport: run.viewport, locale: run.language === "en" ? "en-US" : "zh-CN", timezoneId: "UTC", colorScheme: run.theme,
    ...(run.phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  await context.addInitScript(([language, theme]) => {
    window.EventSource = class { close() {} };
    localStorage.setItem("yuzuno.language", JSON.stringify({ language }));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme, fontSize: 16, palette: "garden" }));
    if (!localStorage.getItem("yuzuno.selected.ws-in")) localStorage.setItem("yuzuno.selected.ws-in", JSON.stringify("l"));
  }, [run.language, run.theme]);
  await context.route("**/*", async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), path = url.pathname;
    if (url.hostname !== HOST) {
      report.unexpected.push(request.url());
      return route.abort();
    }
    if (/^\/api\/agents\/\w\/reading$/.test(path)) return route.fulfill({ json: method === "GET" ? { handoff: null } : { accepted: true, sourceSeq: 0 } });
    if (path === "/api/collaboration/github_repositories") return route.fulfill({ json: { repositories: [], links: [] } });
    if (method !== "GET") {
      if (/^\/api\/agents\/\w\/review$/.test(path)) return route.fulfill({ json: { ok: true } });
      report.posts.push({ run: run.name, method, path });
      return route.fulfill({ status: 500, json: { error: "not answered by this fixture" } });
    }
    const detail = path.match(/^\/api\/agents\/(\w)$/);
    if (detail) return route.fulfill({ json: { agent: agents.find((a) => a.id === detail[1]), pending: [], messageReceipts: [], artifacts: [], turns: [] } });
    const json = {
      "/api/workspace": { workspace: { id: "ws-in" }, agents, projects, runtime: { connected: true }, defaultCwd: "/w" },
      "/api/home": home(),
      "/api/machines": { machines: [] }, "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget,
      "/api/jobs": noJobs, "/api/jobs/live": noLiveJobs, "/api/ci": noCiRuns, "/api/ci/live": noCiRuns, "/api/reviews": noReviews,
    }[path];
    if (json) return route.fulfill({ json });
    if (path.startsWith("/api/")) return route.fulfill({ json: {} });
    const file = resolve(dist, `.${path === "/" ? "/index.html" : path}`);
    assert.ok(file.startsWith(dist + "/"));
    try {
      await route.fulfill({ body: await readFile(file), contentType: types[extname(file)] });
    } catch {
      await route.fulfill({ status: 404, body: "" });
    }
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${run.name}: ${error.message}`));
  const card = (key) => page.locator(`#home-section-${PROJECT}-${key}`);
  const frame = (key) => card(key).locator(".home-card-frame.kind-interactive");
  const shot = async (locator, name) => {
    const file = `${run.name}-${name}.png`;
    await locator.scrollIntoViewIfNeeded();
    await locator.screenshot({ path: join(output, file) });
    result.shots.push(file);
  };
  const press = async (locator) => (run.phone ? locator.tap() : locator.click());
  const noReport = async (what) => {
    assert.equal(await page.locator(".home-report").count(), 0, `${what} opened no report`);
    assert.ok(!page.url().includes("#/report"), `${what}: the address stays Home's`);
  };
  const value = (key) => frame(key).locator(".brief-number-field").inputValue();
  try {
    await page.goto(`http://${HOST}/`);
    if (run.phone) {
      const back = page.locator(".phone-back, [aria-label='All agents'], [aria-label='Back to agents']").first();
      if (await back.isVisible().catch(() => false)) await back.click();
    }
    await page.locator(".catchup-nav:not(.collab-nav)").first().click();
    await card("scones").waitFor({ timeout: 15_000 });
    assert.equal(await page.locator(".home-view").first().getAttribute("lang"), run.language, "Home in the chosen language");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), run.theme, "the chosen theme");

    // ---- Every size draws its Group of inputs live: targets of 40 px, inside the frame, nothing cut.
    const layout = {};
    for (const [key, size] of [["scones", "wide"], ["split", "small"], ["budget", "large"]]) {
      await frame(key).waitFor({ timeout: 10_000 });
      layout[key] = await card(key).evaluate((el) => {
        const body = el.querySelector(".home-card-frame.kind-interactive > .home-card-frame-body");
        const f = body.getBoundingClientRect();
        const targets = [...body.querySelectorAll(".brief-step, .brief-segment, .brief-switch-control, .brief-number-box, .brief-slider")].map((t) => {
          const r = t.getBoundingClientRect();
          return { what: t.className, width: Math.round(r.width), height: Math.round(r.height), inside: r.left >= f.left - 1 && r.right <= f.right + 1 && r.top >= f.top - 1 && r.bottom <= f.bottom + 1 };
        });
        return { size: el.dataset.cardSize, inert: !!body.closest("[inert]") || !!body.querySelector("[inert]"),
          targets, sideways: body.scrollWidth > body.clientWidth + 1, cut: body.scrollHeight > body.clientHeight + 1 };
      });
      const l = layout[key];
      assert.equal(l.size, size, key);
      assert.ok(!l.inert && !l.sideways && !l.cut, `${key}: live, nothing cut or sideways: ${JSON.stringify(l)}`);
      assert.ok(l.targets.length > 0, key);
      for (const t of l.targets) {
        assert.ok(t.inside, `${key}: ${t.what} inside its frame: ${JSON.stringify(t)}`);
        assert.ok(t.height >= 40 && (t.what.includes("brief-slider") || t.what.includes("brief-number-box") || t.width >= 40), `${key}: ${t.what} is a 40 px target: ${JSON.stringify(t)}`);
      }
      await shot(card(key), `card-${size}`);
    }
    pass("a small, a wide and a large card draw their inputs live, every control a 40 px target inside its frame, nothing cut", layout);

    // ---- The stepper, the switch and the segments by pointer or touch; their blocks follow on the card; no report.
    const scrolled = await page.evaluate(() => document.scrollingElement.scrollTop);
    const plus = frame("scones").locator(".brief-step").nth(1);
    assert.equal(await frame("scones").locator(".brief-step").first().getAttribute("aria-label"), w.decrease);
    await press(plus);
    await press(plus);
    await page.waitForFunction((sel) => document.querySelector(sel)?.value === "6", `#home-section-${PROJECT}-scones .brief-number-field`, { timeout: 5000 });
    assert.ok(await frame("scones").getByText("Bake on two trays.").isVisible(), "the block for 6 or more shows on the card");
    await noReport("the stepper");
    const toggle = frame("scones").locator('[role="switch"]');
    assert.equal(await frame("scones").locator(".brief-switch-state").textContent(), w.off);
    await press(toggle);
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    assert.equal(await frame("scones").locator(".brief-switch-state").textContent(), w.on);
    await noReport("the switch");
    const larger = frame("split").locator('[role="radio"]').nth(1);
    await press(larger);
    assert.equal(await larger.getAttribute("aria-checked"), "true");
    assert.ok(await frame("split").getByText("0.015").isVisible() && !(await frame("split").getByText("0.031").isVisible()), "the larger split's numbers");
    await noReport("a segment");
    pass("the stepper, the switch and a segment set the card's variables and its blocks follow; none opens the report", { scrolled });

    // ---- The slider: dragged with the mouse, or with a finger on a phone, without scrolling Home.
    const slider = frame("budget").locator(".brief-slider");
    await slider.scrollIntoViewIfNeeded();
    const box = await slider.boundingBox();
    const before = { rent: await value("budget"), top: await page.evaluate(() => document.scrollingElement.scrollTop) };
    const y = box.y + box.height / 2;
    if (run.phone) {
      // A finger on the slider moves right and a little down: the slider takes it; Home does not scroll.
      const cdp = await context.newCDPSession(page);
      const touch = (type, x, dy = 0) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y: y + dy }] });
      await touch("touchStart", box.x + box.width * 0.2);
      for (let i = 1; i <= 8; i++) await touch("touchMove", box.x + box.width * (0.2 + i * 0.075), i * 4);
      await touch("touchEnd", 0);
      await cdp.detach();
    } else {
      await page.mouse.move(box.x + box.width * 0.2, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.8, y + 12, { steps: 8 });
      await page.mouse.up();
    }
    await page.waitForTimeout(100);
    const after = { rent: await value("budget"), top: await page.evaluate(() => document.scrollingElement.scrollTop) };
    assert.notEqual(after.rent, before.rent, `the drag moved the slider: ${JSON.stringify({ before, after })}`);
    assert.ok(Math.abs(after.top - before.top) <= 1, `Home did not scroll: ${JSON.stringify({ before, after })}`);
    assert.ok(Number(after.rent.replace(/[^\d.]/g, "")) > 1500 && (await frame("budget").getByText("Over a third").isVisible()), `past 1500, its block shows: ${after.rent}`);
    await noReport("the slider");
    pass("dragging the slider moves it and shows its block, without scrolling Home or opening the report", { before, after });

    // ---- The keyboard: arrows step the number and move the choice; a focused control shows its ring.
    const field = frame("scones").locator(".brief-number-field");
    await field.focus();
    await page.keyboard.press("ArrowUp");
    assert.equal(await value("scones"), "7");
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      const style = getComputedStyle(el);
      return { label: el.getAttribute("aria-label"), outline: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    assert.ok(ring.outline !== "none" && ring.width >= 2, `the focused control shows its ring: ${JSON.stringify(ring)}`);
    await page.keyboard.press("Enter");
    assert.equal(await value("scones"), "8", "Enter presses the focused +");
    await frame("split").locator('[role="radio"][aria-checked="true"]').focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await frame("split").locator('[role="radio"]').first().getAttribute("aria-checked"), "true", "ArrowRight wraps to the first");
    await noReport("the keyboard");
    await shot(card("scones"), "card-wide-set");
    pass("arrows step the number and move the choice, Enter presses +, the focused control shows its ring", ring);

    // ---- The report page: its own values, shared across its parts; back on Home, the card keeps the reader's.
    const opener = card("scones").locator(".home-report-open");
    await press(opener);
    const page_ = page.locator(".home-report");
    await page_.waitFor({ timeout: 10_000 });
    const hero = page_.locator(".report-hero");
    assert.equal(await hero.locator(".brief-number-field").inputValue(), "4", "the page starts from the section's value");
    assert.equal(await hero.locator('[role="switch"]').getAttribute("aria-checked"), "false");
    const method = page_.locator("#report-block-method");
    assert.ok(await method.getByText("Rub the cold butter").isVisible());
    await press(hero.locator('[role="switch"]'));
    await method.getByText("Stir the olive oil").waitFor({ timeout: 5000 });
    assert.equal(await method.getByText("Rub the cold butter").count(), 0);
    await shot(page_, "report");
    await press(page_.locator(".report-back"));
    await page_.waitFor({ state: "detached", timeout: 10_000 });
    assert.equal(await value("scones"), "8", "the card keeps the reader's value");
    assert.equal(await frame("scones").locator('[role="switch"]').getAttribute("aria-checked"), "true");
    pass("the report page starts from the section's values and shares them across its parts; the card keeps its own");

    const widths = await page.evaluate(() => ({ page: document.scrollingElement.scrollWidth, window: innerWidth }));
    assert.ok(widths.page <= widths.window + 1, JSON.stringify(widths));
    await page.screenshot({ path: join(output, `${run.name}-home.png`), fullPage: true });
    result.shots.push(`${run.name}-home.png`);
    pass("nothing wider than the window", widths);
  } finally {
    await context.close();
  }
}
