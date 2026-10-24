// T-170: the composer on a phone screen shorter than the composer area needs,
// in Chromium on a production build, with phone-fixture-server.mjs's crowded
// "conversation" fixture (synthetic content; Mori open, with notices above
// the composer). Mobile Safari showed the composer cut off below the
// keyboard and below a phone held sideways (T-170 comment 7199); Chromium's
// own phone sizes never get that short. Here, at the geometries Safari had:
//   - keyboard: a 402×874 phone with the composer focused, and
//     --visual-height and data-keyboard set as keyboard-viewport.ts sets them
//     for a visual viewport of 377 px; and a 375×667 phone left 300 px;
//   - sideways: 874×292 with Safari's insets (top 0, right 62, bottom 20,
//     left 62) on --safe-*;
// the composer is whole inside the panel and above what is covered, a tap
// reaches the input and Send, nothing runs off the side, and the notices
// that gave way can be scrolled to their end. The taller sizes (402×874
// upright, 844×390 sideways) are only measured, for comparing with a build
// from before. An emulated phone is not Safari: no on-screen keyboard here.
//   YUZUNO_UI_DIST=<isolated build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/phone-short-screen-check.mjs [--baseline]
// --baseline only measures (a build from before).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || "../target/phone-short-screen");
await mkdir(output, { recursive: true });
const tools = fileURLToPath(new URL(".", import.meta.url));
const report = { mode: baseline ? "baseline" : "check", cases: [], checks: [], failures: [], errors: [] };

const port = 22000 + (process.pid % 20000);
const server = spawn(process.execPath, [resolve(tools, "phone-fixture-server.mjs")], {
  env: { ...process.env, YUZUNO_UI_DIST: dist, YUZUNO_MEASURE_OUT: resolve(output, "server-measure.jsonl"), YUZUNO_PORT: String(port), YUZUNO_FIXTURE: "conversation" },
  stdio: ["ignore", "pipe", "inherit"],
});
const exited = new Promise((done) => server.once("exit", done));
await new Promise((ready, fail) => {
  server.stdout.on("data", (chunk) => { if (String(chunk).includes("phone fixture:")) ready(); });
  exited.then((code) => fail(new Error(`the fixture server exited (${code})`)));
});
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });

/** The panel and the composer as shown, below `bottom` covered. */
const measure = (bottom) => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) };
  };
  const reached = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  };
  const panel = document.querySelector(".main-panel");
  const area = panel.querySelector(".composer-area");
  const composer = area.querySelector(":scope > .composer");
  const notices = [...area.children].filter((el) => !el.matches(".composer, .composer-footnote") && el.getClientRects().length);
  return {
    inner: [innerWidth, innerHeight],
    bottom,
    panel: box(panel),
    area: box(area),
    composer: box(composer),
    input: box(panel.querySelector("[data-composer-input]")),
    send: box(panel.querySelector(".send-button")),
    reached: { input: reached(panel.querySelector("[data-composer-input]")), send: reached(panel.querySelector(".send-button")) },
    composerWide: composer ? { scroll: composer.scrollWidth, client: composer.clientWidth } : null,
    sideways: document.documentElement.scrollWidth > innerWidth,
    notices: notices.map((el) => ({ el: `${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).join(".")}`, box: box(el), scroll: el.scrollHeight, client: el.clientHeight })),
  };
};

async function open(name, { viewport, keyboard, safe }) {
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${name}: ${error.message}`));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator(".app").waitFor();
  const input = page.locator('[data-composer-input][aria-label="Message Mori"]');
  if (!(await input.isVisible().catch(() => false))) {
    if (!(await page.locator(".app.phone-list").count())) await page.locator(".phone-back").click();
    await page.locator('.agent-row .agent-select[aria-label="Open Mori"]').click();
  }
  await input.waitFor();
  await page.locator(".main-panel .conversation-scroll .turn").last().waitFor();
  await page.waitForTimeout(600);
  if (safe) await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) document.documentElement.style.setProperty(`--safe-${k}`, v); }, safe);
  let bottom = viewport.height;
  if (keyboard) {
    await input.click();
    // As keyboard-viewport.ts sets them for a visual viewport this tall.
    await page.evaluate((h) => {
      document.documentElement.style.setProperty("--visual-height", `${h}px`);
      document.documentElement.setAttribute("data-keyboard", "");
    }, keyboard);
    bottom = keyboard;
  }
  await page.waitForTimeout(500);
  return { context, page, bottom };
}

const short = [
  { name: "keyboard 402×874, 377 px left", viewport: { width: 402, height: 874 }, keyboard: 377 },
  { name: "keyboard 375×667, 300 px left", viewport: { width: 375, height: 667 }, keyboard: 300 },
  { name: "sideways 874×292, Safari's insets", viewport: { width: 874, height: 292 }, safe: { top: "0px", right: "62px", bottom: "20px", left: "62px" } },
];
const tall = [
  { name: "upright 402×874", viewport: { width: 402, height: 874 } },
  { name: "sideways 844×390", viewport: { width: 844, height: 390 } },
];

try {
  for (const shape of [...short, ...tall]) {
    const { context, page, bottom } = await open(shape.name, shape);
    try {
      const seen = await page.evaluate(measure, bottom);
      // The notices that gave way, scrolled to their end: every one can be read.
      const scrolled = await page.evaluate(() =>
        [...document.querySelectorAll(".main-panel .composer-area > :not(.composer, .composer-footnote)")].filter((el) => el.getClientRects().length).map((el) => {
          el.scrollTop = el.scrollHeight;
          return el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
        }));
      await page.screenshot({ path: resolve(output, `${report.mode}-${shape.name.replace(/[^a-z0-9]+/gi, "-")}.png`) });
      report.cases.push({ name: shape.name, short: short.includes(shape), ...seen, scrolledToEnd: scrolled });
      if (baseline || !short.includes(shape)) continue;
      const limit = Math.min(bottom, seen.panel.bottom);
      try {
        assert.ok(seen.composer && seen.composer.bottom <= limit + 1 && seen.composer.top >= seen.panel.top - 1, `the composer whole on screen: ${JSON.stringify(seen.composer)} within ${seen.panel.top}..${limit}`);
        assert.ok(seen.send && seen.send.bottom <= limit + 1, `Send above what is covered: ${JSON.stringify(seen.send)} ≤ ${limit}`);
        assert.deepEqual(seen.reached, { input: true, send: true }, "a tap reaches the input and Send");
        assert.equal(seen.sideways, false, "nothing runs off the side");
        assert.ok(scrolled.every(Boolean), "each notice that gave way can be scrolled to its end");
        check(`${shape.name}: the composer and Send whole above what is covered, reached by a tap; nothing off the side; the notices scroll`, { composer: seen.composer, send: seen.send, notices: seen.notices });
      } catch (error) {
        report.failures.push({ case: shape.name, message: String(error.message).split("\n")[0] });
        console.log(`FAIL ${shape.name}: ${String(error.message).split("\n")[0]}`);
      }
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(report.errors, []);
  report.status = baseline ? "measured" : report.failures.length ? "failed" : "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.stack || String(error);
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await exited;
  await writeFile(resolve(output, `${report.mode}-report.json`), JSON.stringify(report, null, 2) + "\n");
  console.log(`${report.status}: ${resolve(output, `${report.mode}-report.json`)}`);
  if (report.error) console.error(report.error);
  if (report.status === "failed") process.exitCode = 1;
}

function check(name, extra = {}) {
  report.checks.push({ name, ...extra });
  console.log(`PASS ${name}`);
}
