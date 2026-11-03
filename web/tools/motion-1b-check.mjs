// T-19 batch 1b, dialogs (M1): in Chromium on a production build of the
// labelled design preview (?preview=1, synthetic Agents, no Core). A dialog
// enters with a fade and a 4px rise (a confirmation only fades). When it
// closes, Radix still removes it at once, and what fades out is a copy
// (DialogExitGhost.tsx). Every frame from the close is sampled, to show:
// the dialog is gone; focus is back where the build before this batch put
// it (--baseline records that); no Radix aria-hidden mark or scroll lock is
// left; the copy is aria-hidden, inert and clicked through, adds no
// duplicate id and is gone within 400 ms; under reduced motion there is no
// copy; reopening during the exit shows the new dialog at once. Both ways a
// dialog closes are covered: its `open` going false (New agent, Jobs) and its
// unmounting while open (Disconnect). An emulated phone is not a real one,
// and Chromium is not Safari.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/motion-1b-check.mjs [--baseline]
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { launchBrowser } from "./browser-engine.mjs";
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/motion-1b");
await mkdir(output, { recursive: true });
const report = { mode: baseline ? "baseline" : "check", checks: [], failures: [], errors: [], apiCalls: [], notShown: [], focus: {}, exits: {} };
// A baseline run records focus only; the build before this batch has no copy to look for.
const ok = (name, cond, detail) => {
  if (baseline) return;
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

const describe = (page) => page.evaluate(() => window.__describe(document.activeElement));
const ms = (v) => (v.endsWith("ms") ? parseFloat(v) : v.endsWith("s") ? parseFloat(v) * 1000 : NaN);

/** In the page: what a frame shows. The dialog's own nodes are those outside the copy. */
function pageHelpers() {
  window.__describe = (el) => {
    if (!el || el === document.body) return "body";
    return `${el.tagName.toLowerCase()}${el.className ? "." + el.className.toString().trim().split(/\s+/).slice(0, 2).join(".") : ""}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}`;
  };
  window.__state = () => {
    const ghost = document.querySelector(".dialog-exit-ghost");
    const outside = (list) => [...list].filter((el) => !ghost?.contains(el));
    const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
    return {
      dialog: outside(document.querySelectorAll('[role="dialog"], .modal')).length,
      ghost: !!ghost,
      ghostHidden: ghost ? ghost.getAttribute("aria-hidden") === "true" && ghost.inert && getComputedStyle(ghost).pointerEvents === "none" : null,
      ghostRoles: ghost ? ghost.querySelectorAll("[role], [id], [aria-modal]").length : 0,
      ghostAnimations: ghost ? ghost.getAnimations({ subtree: true }).map((a) => `${a.animationName}:${a.effect.getTiming().duration}`) : [],
      ariaHiddenMarks: document.querySelectorAll("[data-aria-hidden]").length,
      scrollLocked: document.body.hasAttribute("data-scroll-locked") || getComputedStyle(document.body).overflow === "hidden",
      duplicateIds: ids.length - new Set(ids).size,
      focus: window.__describe(document.activeElement),
      focusInGhost: !!ghost?.contains(document.activeElement),
    };
  };
  /** Sample every frame from the next Escape or click, for `span` ms. */
  window.__watch = (span = 700) => {
    window.__frames = [];
    const start = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      removeEventListener("keydown", start, true);
      removeEventListener("click", start, true);
      const t0 = performance.now();
      window.__frames.push({ t: 0, phase: "before", ...window.__state() });
      const frame = () => {
        const t = performance.now() - t0;
        window.__frames.push({ t: Math.round(t), ...window.__state() });
        if (t < span) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    addEventListener("keydown", start, true);
    addEventListener("click", start, true);
  };
}

/** Open a dialog, read its entrance, close it and judge every frame after. */
async function exitCase(page, tag, reduced, { name, open, close, confirm = false, clickThrough = false }) {
  const before = await page.evaluate(() => window.__state());
  if (!(await open())) return report.notShown.push(`${tag}: ${name} could not be opened in the preview`);
  // As computed, so an entrance already over still counts; the keyframes themselves are checked once per run.
  const entrance = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".modal-overlay, .modal")]
    .filter((el) => !el.closest(".dialog-exit-ghost"))
    .map((el) => { const s = getComputedStyle(el);
      return [el.classList.contains("modal") ? "box" : "overlay", { name: s.animationName, duration: s.animationDuration, easing: s.animationTimingFunction }]; })));
  await page.waitForTimeout(350);
  if (!baseline) {
    const { box, overlay } = entrance;
    if (reduced) ok(`${tag}: ${name} opens with no animation under reduced motion`, box?.name === "none" && overlay?.name === "none", entrance);
    else
      ok(`${tag}: ${name} enters over medium with the standard easing: the overlay fades, the box ${confirm ? "only fades" : "fades and rises 4px"}`,
        overlay?.name === "dialog-fade-in" && ms(overlay.duration) === 240 && ms(box?.duration) === 240 && /cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/.test(box.easing) &&
          box.name === (confirm ? "dialog-fade-in" : "dialog-in"), entrance);
  }
  const rect = await page.evaluate(() => {
    const r = [...document.querySelectorAll(".modal")].find((el) => !el.closest(".dialog-exit-ghost")).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.evaluate(() => {
    window.__clicks = [];
    document.addEventListener("click", (e) => window.__clicks.push({ ghost: !!document.querySelector(".dialog-exit-ghost"),
      inGhost: !!e.target.closest?.(".dialog-exit-ghost"), target: window.__describe(e.target) }), { capture: true });
  });
  await page.evaluate(() => window.__watch(700));
  await close();
  if (clickThrough) await page.mouse.click(rect.x, rect.y);
  await page.waitForTimeout(800);
  const frames = await page.evaluate(() => window.__frames);
  const after = frames.filter((f) => f.phase !== "before");
  report.focus[`${tag}: ${name} closed`] = await describe(page);
  report.exits[`${tag}: ${name}`] = frames;
  if (baseline) return;
  const first = after[0] || {};
  const ghostFrames = after.filter((f) => f.ghost);
  // Where focus settles is compared with the build before this batch (BASELINE_REPORT); here, that it is there at once.
  const settled = after.at(-1)?.focus;
  ok(`${tag}: ${name}: in the first frame after the close the dialog is gone, focus is where it settles (${settled}), and no aria-hidden mark or scroll lock is left`,
    first.dialog === 0 && first.focus === settled && !first.focusInGhost && first.ariaHiddenMarks === before.ariaHiddenMarks && first.scrollLocked === before.scrollLocked,
    { before, first });
  if (reduced) {
    ok(`${tag}: ${name}: no copy under reduced motion`, ghostFrames.length === 0, ghostFrames.length);
  } else {
    ok(`${tag}: ${name}: a copy fades out, aria-hidden, inert and clicked through, with no role, id or duplicate id`,
      ghostFrames.length > 0 && ghostFrames.every((f) => f.ghostHidden && f.ghostRoles === 0 && f.duplicateIds === before.duplicateIds), ghostFrames.slice(0, 2));
    const animations = ghostFrames[0]?.ghostAnimations || [];
    ok(`${tag}: ${name}: the copy plays exit-medium, the box ${confirm ? "only fading" : "fading and sinking 4px"}`,
      animations.includes("dialog-fade-out:170") && animations.includes(`${confirm ? "dialog-fade-out" : "dialog-out"}:170`), animations);
    const last = ghostFrames.at(-1)?.t ?? Infinity;
    ok(`${tag}: ${name}: the copy is gone within 400 ms (last seen at ${last} ms)`, last <= 400 && !after.at(-1).ghost, last);
  }
  if (clickThrough) {
    const click = await page.evaluate(() => window.__clicks.at(-1));
    ok(`${tag}: ${name}: a click right where the dialog was lands on the page${reduced ? "" : ", not on the copy"}`,
      !!click && !click.inGhost && (reduced || click.ghost), click);
  }
}

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
  const page = await context.newPage();
  page.on("pageerror", (e) => report.errors.push(`${tag}: ${String(e).slice(0, 300)}`));
  await page.route("**/*", serve);
  await page.addInitScript(pageHelpers);
  await page.goto("http://yuzuno-motion.test/?preview=1");
  await page.locator(".agent-row, .phone-dock-button").first().waitFor();
  await page.waitForTimeout(400);
  if (!baseline) {
    const keyframes = await page.evaluate(() => {
      const out = {};
      for (const sheet of document.styleSheets)
        for (const rule of sheet.cssRules) if (rule instanceof CSSKeyframesRule && rule.name.startsWith("dialog-")) out[rule.name] = rule.cssText;
      return out;
    });
    const moves = (n) => /translate/.test(keyframes[n] || "");
    ok(`${tag}: the dialog keyframes: dialog-in and dialog-out move 4px, the fades only fade`,
      ["dialog-in", "dialog-out", "dialog-fade-in", "dialog-fade-out"].every((n) => keyframes[n]) && moves("dialog-in") && moves("dialog-out") &&
        /4px/.test(keyframes["dialog-in"]) && !moves("dialog-fade-in") && !moves("dialog-fade-out"), keyframes);
  }
  const visible = (selector) => page.locator(selector).filter({ visible: true }).first();
  const clickIfShown = async (selector) => {
    const el = visible(selector);
    if (!(await el.count())) return false;
    await el.click();
    await page.locator(".modal").first().waitFor({ timeout: 3000 });
    return true;
  };

  // A Modal closed by its `open` (New agent), with a click right where it was.
  await exitCase(page, tag, reduced, { name: "New agent", open: () => clickIfShown(".add-agent"),
    close: () => page.keyboard.press("Escape"), clickThrough: true });
  await page.keyboard.press("Escape");

  // Reopened during its exit: the new dialog shows at once, above the copy, with focus in it.
  if (!baseline && (await visible(".add-agent").count())) {
    await clickIfShown(".add-agent");
    await page.waitForTimeout(350);
    await page.keyboard.press("Escape");
    await visible(".add-agent").click();
    const reopened = await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const box = [...document.querySelectorAll(".modal")].find((el) => !el.closest(".dialog-exit-ghost"));
      const r = box?.getBoundingClientRect();
      done({ open: !!box, focusIn: !!box?.contains(document.activeElement), ghost: !!document.querySelector(".dialog-exit-ghost"),
        onTop: !!r && box.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 20)) });
    }))));
    ok(`${tag}: reopened during its exit, the dialog shows at once with focus in it, above any copy`, reopened.open && reopened.focusIn && reopened.onTop, reopened);
    await page.waitForTimeout(350);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }

  // Jobs: a direct Radix dialog.
  await exitCase(page, tag, reduced, { name: "Jobs", open: () => clickIfShown(".jobs-nav"), close: () => page.keyboard.press("Escape") });

  // Disconnect: a confirmation that unmounts while open, from an Agent's action menu.
  await exitCase(page, tag, reduced, {
    name: "Disconnect", confirm: true,
    open: async () => {
      const row = visible(".agent-row");
      if (!(await row.count())) return false;
      await row.hover();
      const more = visible(".agent-actions-button");
      if (!(await more.count())) return false;
      await more.click();
      const item = page.locator('.agent-actions-menu [role="menuitem"]', { hasText: /^Disconnect/ }).first();
      if (!(await item.count())) {
        await page.keyboard.press("Escape");
        return false;
      }
      await item.click();
      await page.locator(".modal").first().waitFor({ timeout: 3000 });
      return true;
    },
    close: () => page.locator(".modal .secondary-button", { hasText: /^Cancel/ }).first().click(),
  });
  if (!reduced && !baseline && !run.phone) await page.screenshot({ path: join(output, `${tag}-after.png`) });
  await context.close();
}
await browser.close();

// Focus against the build before this batch: the same places, or a difference to explain.
if (process.env.BASELINE_REPORT) {
  const before = JSON.parse(await readFile(process.env.BASELINE_REPORT, "utf8")).focus;
  for (const [where, after] of Object.entries(report.focus))
    ok(`focus unchanged by this batch: ${where}`, before[where] === after, { before: before[where], after });
}
report.passed = report.failures.length === 0 && report.errors.length === 0;
await writeFile(join(output, "motion-1b-check.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ mode: report.mode, passed: report.passed, checks: report.checks.length, failures: report.failures.length, errors: report.errors.length, notShown: report.notShown, focus: report.focus }));
process.exit(report.passed ? 0 : 1);
