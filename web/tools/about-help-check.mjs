// T-191: About & help in Settings, in Chromium, with a disposable fixture
// server (no Core) that serves the real build, its licenses/ included: opened
// from Updates & about at 1280, 390 and 320 px, it fits, the three license
// texts this build ships open in place, its links leave for GitHub, and
// it sends nothing.
//   YUZUNO_UI_DIST=<build> YUZUNO_BROWSER_OUTPUT=<dir> node tools/about-help-check.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import { unmanagedUpdates } from "./browser-fixtures.mjs";

assert.ok(process.env.YUZUNO_UI_DIST, "YUZUNO_UI_DIST: the web build to serve");
assert.ok(process.env.YUZUNO_BROWSER_OUTPUT, "YUZUNO_BROWSER_OUTPUT: where screenshots and the report go");
const dist = resolve(process.env.YUZUNO_UI_DIST);
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
await mkdir(output, { recursive: true });

const updates = {
  ...unmanagedUpdates,
  managed: true,
  reason: undefined,
  current: {
    ...unmanagedUpdates.current,
    releaseId: "core-20261024-c215011",
    version: "2026.10.24-core.17",
    gitSha: "c215011" + "9".repeat(33),
    notes: "Fixture notes for this release.\n- Settings gains Runtime & versions.\n- A long line that has to wrap inside the narrow dialog without widening the page at all.",
  },
};
const answers = {
  "/api/updates": updates,
  "/api/workspace": { agents: [], runtime: { connected: true, account: "person@example.test" }, defaultCwd: "/fixture/project" },
  "/api/machines": { machines: [] },
  "/api/home": { generatedAt: new Date().toISOString(), order: [], needsYou: [], projects: [] },
};
const calls = [];
const report = { checks: [], screenshots: [], errors: [], console: [], requests: {} };
const check = (name) => {
  report.checks.push(name);
  console.log(name);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture.test");
  calls.push(`${req.method} ${url.pathname}`);
  if (url.pathname.startsWith("/api/")) {
    for await (const _ of req);
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": fixture\n\n");
      return;
    }
    const value = answers[url.pathname];
    res.writeHead(value === undefined ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value ?? { error: "Not served by this fixture" }));
    return;
  }
  // As Core serves the build: a file it has, else index.html.
  const path = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
  const file = path.startsWith(dist + sep) ? await readFile(path).catch(() => null) : null;
  const served = file ?? (await readFile(resolve(dist, "index.html")));
  res.writeHead(200, { "Content-Type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain" }[file ? extname(path) : ".html"] || "application/octet-stream" });
  res.end(served);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
async function shot(target, name) {
  await target.screenshot({ path: resolve(output, `${name}.png`), animations: "disabled" });
  report.screenshots.push(`${name}.png`);
}
const licenses = [
  ["Yuzuno · Apache License 2.0", /Apache License\s+Version 2\.0, January 2004/],
  ["Noto Sans SC font · SIL Open Font License 1.1", /SIL OPEN FONT LICENSE/i],
  ["Third-party notices for this page", /Third-party software in the Yuzuno web UI/],
];

try {
  for (const [label, width, height, phone] of [["desktop", 1280, 860, false], ["390", 390, 844, true], ["320", 320, 700, true]]) {
    calls.length = 0;
    const context = await browser.newContext({ viewport: { width, height }, ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(String(error)));
    page.on("console", (message) => message.type() === "error" && report.console.push(message.text()));
    // A link that leaves must not navigate this window.
    const popups = [];
    context.on("page", (popup) => popups.push(popup.url()));
    await page.goto(origin);
    await page.getByRole("button", { name: "Settings and updates" }).click();
    await page.getByRole("dialog", { name: "Settings" }).waitFor();
    await page.locator(".settings-entries").getByRole("button", { name: "About & help", exact: true }).click();
    const section = page.locator("#settings-about");
    await section.getByRole("group", { name: "This version" }).waitFor();
    for (const [title, text] of licenses) {
      const details = section.locator(".about-license", { has: page.locator("summary", { hasText: title }) });
      await details.locator("summary").click();
      await details.locator("pre").waitFor();
      assert.match(await details.locator("pre").textContent(), text, `${title} is this build's own text`);
    }
    await section.locator(".updates-notes", { has: page.locator("summary", { hasText: "What’s in" }) }).locator("summary").click();
    await page.waitForTimeout(200);
    const fit = await section.evaluate((el, width) => {
      const r = el.getBoundingClientRect();
      const overflow = [...el.querySelectorAll("*")].filter((n) => n.scrollWidth > n.clientWidth + 1 && !["auto", "scroll"].includes(getComputedStyle(n).overflowX)).map((n) => n.className || n.tagName);
      return { left: r.left, right: r.right, inside: r.left >= 0 && r.right <= width, overflow, page: document.documentElement.scrollWidth <= innerWidth };
    }, width);
    assert.ok(fit.inside && fit.page && fit.overflow.length === 0, `the section fits ${width} px: ${JSON.stringify(fit)}`);
    // Only the dialog's pane scrolls: shoot the section screen by screen.
    const pane = page.locator(".settings-pane");
    const steps = await pane.evaluate((el) => {
      const r = el.querySelector("#settings-about").getBoundingClientRect();
      const top = el.scrollTop + r.top - el.getBoundingClientRect().top - 8;
      const bottom = top + r.height + 8;
      const stops = [];
      for (let y = top; y < bottom; y += Math.max(1, el.clientHeight - 40)) stops.push(y);
      return stops;
    });
    assert.ok(steps.length <= 12, `the section takes ${steps.length} screens at ${width} px`);
    for (const [i, y] of steps.entries()) {
      await pane.evaluate((el, y) => (el.scrollTop = y), y);
      await page.waitForTimeout(80);
      await shot(page, `${label}-about-${i + 1}`);
    }
    check(`${label}: About & help opens from Updates & about, fits, and opens this build's three license texts and the release notes in place`);
    const issues = section.getByRole("link", { name: "Report a problem or request a feature" });
    assert.equal(await issues.getAttribute("target"), "_blank");
    await issues.focus();
    assert.equal(await issues.evaluate((el) => el === document.activeElement), true, "the link takes focus");
    report.requests[label] = [...calls];
    // Updates' own check when Settings opens on a managed install is the one
    // write; About & help sends nothing.
    assert.deepEqual(calls.filter((c) => !c.startsWith("GET ")), ["POST /api/updates/check"], "nothing sent but Updates' own check");
    assert.deepEqual(popups, [], "nothing opened by itself");
    check(`${label}: links take focus and open outside; About & help only GETs, the three /licenses/ files among them`);
    for (const file of ["LICENSE", "LICENSE-NotoSansSC.txt", "THIRD_PARTY_NOTICES.txt"])
      assert.ok(calls.includes(`GET /licenses/${file}`), `read ${file}`);
    await context.close();
  }
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = String(error?.stack || error);
  throw error;
} finally {
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
}
