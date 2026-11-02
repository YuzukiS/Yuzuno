// T-19 batch 1a: the shared motion tokens, press and hover, the toast layer
// and reduced motion, in Chromium on a production build of the labelled
// design preview (?preview=1, synthetic Agents, no Core). Ordinary controls
// dip to .97 when pressed; anything that approves, answers or destroys only
// takes the pressed colour; with reduced motion nothing scales; the toasts
// sit above an open dialog; the "go to pending" jump scrolls smoothly only
// without reduced motion; focus still returns as before when a menu or a
// dialog closes, on a desktop and on a touch phone. Screenshots for review.
// An emulated phone is not a real one, and Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-1a-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-1a");
await mkdir(output, { recursive: true });
const report = { checks: [], failures: [], errors: [], apiCalls: [], notShown: [] };
const ok = (name, cond, detail) => {
  (cond ? report.checks : report.failures).push({ name, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};
const api = {
  "/api/updates": unmanagedUpdates, "/api/jobs/budget": idleJobsBudget, "/api/jobs/live": noLiveJobs,
  "/api/jobs": noJobs, "/api/ci": noCiRuns, "/api/reviews": noReviews,
};
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".png": "image/png", ".woff2": "font/woff2",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };

async function serve(route) {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith("/api/")) {
    report.apiCalls.push(`${route.request().method()} ${url.pathname}`);
    const hit = Object.keys(api).sort((a, b) => b.length - a.length).find((p) => url.pathname === p || url.pathname.startsWith(p + "/"));
    if (hit && route.request().method() === "GET") return route.fulfill({ json: api[hit] });
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

/** Press and hold `selector`, read its transform and shadow, then leave without a click. */
async function press(page, selector, shot) {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(220);
  const state = await el.evaluate((node) => ({
    active: node.matches(":active"), disabled: node.disabled === true,
    transform: getComputedStyle(node).transform, shadow: getComputedStyle(node).boxShadow,
  }));
  if (shot) await el.screenshot({ path: join(output, shot) });
  await page.mouse.move(2, 2);
  await page.mouse.up();
  await page.waitForTimeout(150);
  return state;
}
const pressedScale = (s) => s.active && /^matrix\(0\.97, 0, 0, 0\.97/.test(s.transform);
const pressedStill = (s) => s.active && s.transform === "none" && /inset/.test(s.shadow);

const browser = await launchBrowser();
report.browser = browser.version();
const runs = [
  { name: "desktop", viewport: { width: 1280, height: 860 }, reducedMotion: "no-preference" },
  { name: "desktop-reduced", viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" },
  { name: "phone", viewport: { width: 390, height: 844 }, reducedMotion: "no-preference", phone: true },
  { name: "phone-reduced", viewport: { width: 390, height: 844 }, reducedMotion: "reduce", phone: true },
];
for (const run of runs) {
  const tag = run.name;
  const reduced = run.reducedMotion === "reduce";
  const context = await browser.newContext({ viewport: run.viewport, reducedMotion: run.reducedMotion,
    hasTouch: !!run.phone, isMobile: !!run.phone, deviceScaleFactor: run.phone ? 2 : 1 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  // Record the behavior every scroll call asks for.
  await page.addInitScript(() => {
    window.__scrolls = [];
    for (const name of ["scrollTo", "scrollIntoView"]) {
      const original = Element.prototype[name];
      Element.prototype[name] = function (...args) {
        const options = args[0] && typeof args[0] === "object" ? args[0] : {};
        window.__scrolls.push({ name, behavior: options.behavior ?? null, cls: this.className?.toString?.().slice(0, 40) ?? "" });
        return original.apply(this, args);
      };
    }
  });
  await page.goto("http://yuzuno-motion.test/?preview=1");
  await page.locator(".agent-row").first().waitFor();
  await page.waitForTimeout(400);

  // Tokens, and no transition on "all" with a duration anywhere.
  const tokens = await page.evaluate(() => Object.fromEntries(["micro", "small", "medium", "exit-small", "exit-medium", "settle", "reveal"]
    .map((n) => [n, getComputedStyle(document.documentElement).getPropertyValue(`--motion-${n}`).trim()])));
  ok(`${tag}: motion tokens are defined`, JSON.stringify(tokens) === JSON.stringify({ micro: "120ms", small: "180ms", medium: "240ms",
    "exit-small": "130ms", "exit-medium": "170ms", settle: "1200ms", reveal: "420ms" }), tokens);
  const allTransitions = await page.evaluate(() => [...document.querySelectorAll("*")].filter((el) => {
    const s = getComputedStyle(el);
    const props = s.transitionProperty.split(", "), durations = s.transitionDuration.split(", ");
    return props.some((p, i) => p === "all" && parseFloat(durations[i % durations.length]) > 0);
  }).map((el) => el.className.toString().slice(0, 40)));
  ok(`${tag}: no element transitions "all"`, allTransitions.length === 0, allTransitions);

  if (!run.phone) {
    // Ordinary press: a toolbar nav button and a header action.
    const nav = await press(page, ".toolbar-nav .catchup-nav", reduced ? null : "press-ordinary-nav.png");
    ok(`${tag}: an ordinary button ${reduced ? "keeps its size but takes the pressed colour" : "dips to .97 with the pressed colour"}`,
      reduced ? nav.active && nav.transform === "none" && /inset/.test(nav.shadow) : pressedScale(nav) && /inset/.test(nav.shadow), nav);
    const navDuration = await page.locator(".toolbar-nav .catchup-nav").first().evaluate((n) => getComputedStyle(n).transitionDuration);
    ok(`${tag}: the nav button's transitions use micro (or none under reduced motion)`, reduced ? navDuration === "0s" : navDuration === "0.12s, 0.12s, 0.12s", navDuration);

    // Hana's question: choose an answer, then press Send: colour only.
    await page.locator(".agent-row", { hasText: "Hana" }).first().click();
    await page.locator(".pending-card").first().waitFor();
    await page.locator(".pending-card .answer-option").first().click();
    const send = page.locator(".pending-card .primary-button").first();
    await send.waitFor();
    const answer = await press(page, ".pending-card .primary-button", reduced ? null : "press-answer-still.png");
    ok(`${tag}: an answer button in a request card never moves, and takes the pressed colour`, pressedStill(answer), answer);

    // "Go to pending": smooth only without reduced motion.
    const shortcut = page.locator(".pending-shortcut");
    if (await shortcut.count()) {
      await page.evaluate(() => (window.__scrolls.length = 0));
      await shortcut.first().click();
      const scrolls = await page.evaluate(() => window.__scrolls.filter((s) => s.name === "scrollTo"));
      ok(`${tag}: "go to pending" scrolls ${reduced ? "instantly" : "smoothly"}`, scrolls.length > 0 && scrolls.at(-1).behavior === (reduced ? "auto" : "smooth"), scrolls);
    } else report.notShown.push(`${tag}: the "go to pending" shortcut was not on screen`);

    // Mori is working: Interrupt never moves.
    await page.locator(".agent-row", { hasText: "Mori" }).first().click();
    await page.waitForTimeout(200);
    if (await page.locator(".interrupt-button").count()) {
      const stop = await press(page, ".interrupt-button", reduced ? null : "press-interrupt-still.png");
      ok(`${tag}: Interrupt never moves, and takes the pressed colour`, pressedStill(stop), stop);
    } else report.notShown.push(`${tag}: Interrupt was not shown for the preview's working Agent`);

    // A dialog: its actions never move; Escape returns focus to the opener as before.
    await page.locator(".add-agent").first().click();
    await page.locator(".modal").first().waitFor();
    await page.waitForTimeout(300);
    const cancel = await press(page, ".modal-actions .secondary-button", reduced ? null : "press-dialog-action-still.png");
    ok(`${tag}: a dialog's action never moves, and takes the pressed colour`, pressedStill(cancel), cancel);
    const layers = await page.evaluate(() => ({ toasts: getComputedStyle(document.querySelector(".toast-stack")).zIndex,
      overlay: getComputedStyle(document.querySelector(".modal-overlay")).zIndex }));
    ok(`${tag}: the toast layer sits above an open dialog's overlay`, Number(layers.toasts) > Number(layers.overlay), layers);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    ok(`${tag}: closing the dialog returns focus to New agent`, await page.evaluate(() => document.activeElement?.classList.contains("add-agent")));

    // A theme switch: every colour changes in the same frame, no transition runs.
    const settings = page.locator(".workspace-settings, [aria-label='Settings']").first();
    if (await settings.count()) {
      await settings.click();
      await page.locator(".modal").first().waitFor();
      const tab = page.locator('[role="tab"]', { hasText: /^Appearance/ }).first();
      if (await tab.count()) await tab.click();
      const dark = page.locator(".theme-choice-dark").first();
      if (await dark.count()) {
        const tweens = await dark.evaluate(async (label) => {
          label.click();
          let most = 0;
          for (let i = 0; i < 6; i++) {
            most = Math.max(most, document.getAnimations().filter((a) => a instanceof CSSTransition).length);
            await new Promise((r) => requestAnimationFrame(r));
          }
          return most;
        });
        ok(`${tag}: switching to the dark theme runs no colour transition (six frames sampled)`, tweens === 0, tweens);
        if (!reduced) await page.screenshot({ path: join(output, "theme-dark-settings.png") });
        await page.locator(".theme-choice-light").first().click();
      } else report.notShown.push(`${tag}: the theme choices were not found in Settings`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    } else report.notShown.push(`${tag}: no Settings entry in the preview toolbar`);

    // A real toast, then a dialog opened over it: the toast stays visible on top.
    await page.locator(".agent-row", { hasText: "Mikan" }).first().click({ button: "right" });
    const copy = page.locator('[role="menuitem"]', { hasText: /Copy link/i });
    if (await copy.count()) {
      await copy.first().click();
      await page.locator(".toast-stack .toast").first().waitFor({ timeout: 3000 });
      await page.locator(".add-agent").first().click();
      await page.locator(".modal").first().waitFor();
      await page.waitForTimeout(300);
      const onTop = await page.evaluate(() => {
        const toast = document.querySelector(".toast-stack .toast");
        const r = toast.getBoundingClientRect();
        return toast.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      });
      ok(`${tag}: a toast shown under an open dialog stays on top and visible`, onTop);
      if (!reduced) await page.screenshot({ path: join(output, "toast-over-dialog.png") });
      await page.keyboard.press("Escape");
    } else report.notShown.push(`${tag}: Copy link was not in the Agent menu`);
    if (!reduced) await page.screenshot({ path: join(output, `desktop-${tag}.png`) });
  } else {
    // Phone: open a conversation, press a dock button; open the Agent menu by touch and close it.
    await page.locator(".agent-row", { hasText: "Mori" }).first().tap();
    await page.waitForTimeout(300);
    if (await page.locator(".phone-dock-button").count()) {
      const dock = await press(page, ".phone-dock-button", reduced ? "phone-press-dock-reduced.png" : "phone-press-dock.png");
      ok(`${tag}: a phone dock button ${reduced ? "keeps its size" : "dips to .97"} with the pressed colour`,
        reduced ? dock.active && dock.transform === "none" && /inset/.test(dock.shadow) : pressedScale(dock) && /inset/.test(dock.shadow), dock);
    } else report.notShown.push(`${tag}: no phone dock button in the preview conversation`);
    await page.screenshot({ path: join(output, `${tag}-conversation.png`) });
    const menu = page.locator(".conversation-header [aria-haspopup='menu'], .agent-row-menu").first();
    if (await menu.count()) {
      await menu.tap();
      await page.locator('[role="menu"]').first().waitFor({ timeout: 2000 }).catch(() => {});
      const opened = await page.locator('[role="menu"]').count();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      const back = await page.evaluate(() => document.activeElement?.getAttribute("aria-haspopup") === "menu" || document.activeElement?.classList.contains("agent-row-menu"));
      ok(`${tag}: a menu opened by touch closes with focus back on its trigger`, opened > 0 && back, { opened, back });
    } else report.notShown.push(`${tag}: no Agent menu trigger on the phone conversation`);
  }
  await context.close();
}
await browser.close();
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-1a-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors.length, notShown: report.notShown }));
process.exit(report.passed ? 0 : 1);
