// R-21 (YN-212): the generated design preview (tools/create-preview.mjs) as
// Home shows an HTML attachment: served with Core's own page policy (read
// from core/src/previews.rs page_policy, so it stays Core's) inside an
// iframe sandbox="allow-scripts" (an opaque origin). Chromium 157 throws a
// SecurityError on reading navigator.serviceWorker there; this Chromium may
// not, so every opaque-origin frame gets a getter that throws as it does.
// At a wide window and a phone, in English and Chinese, the preview draws,
// shows no error screen and no page error, and Settings → Notifications
// (which reads the browser's push host) opens too.
//   YUZUNO_UI_DIST=<isolated build with design-preview.html> YUZUNO_BROWSER_OUTPUT=<dir> node tools/preview-sandbox-check.mjs
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

assert.ok(process.env.YUZUNO_UI_DIST, "Use an isolated build");
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve("dist"));
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "Give an output directory");
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });
const html = await readFile(join(dist, "design-preview.html"));

// Core's page policy for a preview, its format string as written, with Home's address as the frame's ancestor.
const HOME = "http://127.0.0.1:47399";
const PAGE = "http://127.0.0.1:47400/v/check";
const previews = await readFile(fileURLToPath(new URL("../../core/src/previews.rs", import.meta.url)), "utf8");
const format = previews.match(/fn page_policy\([^)]*\)[^{]*\{\s*format!\(\s*"((?:[^"\\]|\\[\s\S])*)"/)?.[1];
assert.ok(format, "core/src/previews.rs page_policy's format string");
const POLICY = format.replace(/\\\n\s*/g, "").replace("{}", HOME);
assert.match(POLICY, /^sandbox allow-scripts; default-src 'none';.*frame-ancestors http:\/\/127\.0\.0\.1:47399$/);

const report = { task: "YN-212", request: "R-21", policy: POLICY, runs: [] };
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const sizes = [
  { name: "wide", width: 1290, height: 820 },
  { name: "phone", width: 390, height: 844 },
];
const CRASH = /couldn.t show this screen|无法显示/;
try {
  for (const size of sizes) {
    for (const locale of ["en-US", "zh-CN"]) {
      const run = { size: size.name, locale, errors: [] };
      report.runs.push(run);
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, locale, reducedMotion: "reduce" });
      await context.addInitScript(() => {
        if (self.origin !== "null") return;
        self.__serviceWorkerReads = 0;
        Object.defineProperty(Navigator.prototype, "serviceWorker", {
          configurable: true,
          get() {
            self.__serviceWorkerReads += 1;
            throw new DOMException("Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.", "SecurityError");
          },
        });
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => run.errors.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error" && /serviceWorker|SecurityError/.test(message.text())) run.errors.push(`console: ${message.text()}`);
      });
      await page.route(`${HOME}/`, (route) => route.fulfill({ contentType: "text/html",
        body: `<!doctype html><html><body style="margin:0"><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" allow="" src="${PAGE}" style="border:0;width:100vw;height:100vh"></iframe></body></html>` }));
      await page.route(PAGE, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html, headers: { "Content-Security-Policy": POLICY } }));
      await page.goto(`${HOME}/`);
      await page.waitForTimeout(2500);
      const frame = page.frames().find((f) => f.url() === PAGE);
      assert.ok(frame, "the preview's frame");
      const look = () => frame.evaluate((crash) => ({
        origin: self.origin, secure: self.isSecureContext,
        app: !!document.querySelector(".app"), crashed: new RegExp(crash).test(document.body.innerText),
        reads: self.__serviceWorkerReads, text: document.body.innerText.slice(0, 160),
      }), CRASH.source);
      run.first = await look();
      // Settings → Notifications reads the browser's push host.
      const settings = frame.locator(".workspace-settings").first();
      if (await settings.count()) {
        await settings.click();
        await page.waitForTimeout(500);
        const item = frame.getByText(/^(Notifications|通知)$/).first();
        if (await item.count()) await item.click();
        await page.waitForTimeout(800);
        run.notifications = await look();
      }
      await page.screenshot({ path: join(output, `preview-sandbox-${size.name}-${locale}.png`) });
      await context.close();
      const ok = run.first.origin === "null" && run.first.app && !run.first.crashed && !run.notifications?.crashed && !run.errors.length;
      console.log(`${ok ? "PASS" : "FAIL"} ${size.name} ${locale} ${JSON.stringify({ first: run.first, notifications: run.notifications, errors: run.errors })}`);
      run.ok = ok;
    }
  }
} finally {
  await browser.close();
  await writeFile(join(output, "preview-sandbox-check.json"), `${JSON.stringify(report, null, 2)}\n`);
}
assert.ok(report.runs.every((run) => run.ok), "the preview draws in Home's sandbox where reading serviceWorker throws");
console.log(`preview-sandbox-check: ${report.runs.length} runs`);
