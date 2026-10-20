import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const output = dirname(fileURLToPath(import.meta.url));
const base = "http://127.0.0.1:4327";
const { chromium } = await import(pathToFileURL(resolve(output, "../../web/node_modules/playwright-core/index.mjs")));
const response = await fetch(base + "/api/workspace");
assert.equal(response.ok, true, "Isolated Core unavailable; no browser work started");
const workspace = await response.json();
const remote = workspace.agents.find((agent) => agent.id === "3fca0686-0f2f-4573-a342-bc5db1783b55");
assert.ok(remote?.remote, "Expected existing lab remote Agent");
const report = { capturedAt: new Date().toISOString(), base, viewports: [], blockedRequests: [], browserErrors: [], serviceFailures: [], calls: [], limitations: ["Headless Chromium, isolated profile, no native window or WebView2 assessment", "GET/HEAD requests to port 4327 only; no create/reconnect/mark-read/model turns", "20px theme preferences are written only inside this disposable browser profile"] };
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1040 } });
  await context.addInitScript(() => {
    if (!localStorage.getItem("yuzuno.appearance")) localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "light", fontSize: 20 }));
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (["about:", "data:", "blob:"].includes(url.protocol)) return route.continue();
    if (url.origin !== base || !["GET", "HEAD"].includes(request.method())) {
      report.blockedRequests.push({ url: request.url(), method: request.method() });
      return route.abort("blockedbyclient");
    }
    report.calls.push({ url: request.url(), method: request.method() });
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.browserErrors.push(error.message));
  page.on("requestfailed", (request) => report.serviceFailures.push({ url: request.url(), failure: request.failure()?.errorText }));
  await page.goto(base + "/?shell=desktop");
  await page.locator(".agent-row").filter({ hasText: remote.name }).click();
  await page.locator(".remote-controls").waitFor();
  await page.evaluate(() => document.fonts.ready);
  const seed = process.argv[2] || "initial";
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 1040 });
    for (const theme of ["light", "dark"]) {
      await page.getByRole("button", { name: "Appearance settings", exact: true }).click();
      await page.locator(`input[name="appearance-theme"][value="${theme}"]`).check({ force: true });
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.screenshot({ path: resolve(output, `remote-${seed}-${width}-${theme}-20px.png`), animations: "disabled" });
      const layout = await page.evaluate(() => {
        const box = (node) => { const b = node.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom }; };
        return {
          viewport: innerWidth, contentWidth: document.documentElement.scrollWidth,
          theme: document.documentElement.dataset.theme, fontSize: document.documentElement.dataset.fontSize,
          remoteControls: { ...box(document.querySelector(".remote-controls")), text: document.querySelector(".remote-controls").textContent },
          conversationMeta: box(document.querySelector(".conversation-meta")),
          agents: [...document.querySelectorAll(".agent-row")].map((node) => ({
            name: node.querySelector(".agent-name").textContent, ...box(node),
            contentWidth: node.scrollWidth, machine: node.querySelector(".remote-machine-badge")?.textContent,
            bottom: box(node.querySelector(".agent-row-bottom")),
            badges: [...node.querySelectorAll(".remote-machine-badge,.agent-runtime,.needs-you")].map((child) => ({ text: child.textContent, ...box(child) })),
          })),
          unnamedButtons: [...document.querySelectorAll("button")].filter((node) => !node.textContent.trim() && !node.getAttribute("aria-label") && !node.getAttribute("title")).map((node) => node.outerHTML),
        };
      });
      report.viewports.push(layout);
    }
  }
  const after = await (await fetch(base + "/api/workspace")).json();
  report.reviewedSeqUnchanged = workspace.agents.every((agent) => after.agents.find((next) => next.id === agent.id)?.reviewedSeq === agent.reviewedSeq);
  assert.ok(report.reviewedSeqUnchanged, "Read state changed during read-only visual check");
  assert.equal(report.blockedRequests.length, 0);
  assert.equal(report.browserErrors.length, 0);
  assert.ok(report.viewports.every((layout) => layout.contentWidth <= layout.viewport));
} finally {
  await browser.close();
  await writeFile(resolve(output, `remote-visual-${process.argv[2] || "initial"}.json`), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ viewports: report.viewports.length, browserErrors: report.browserErrors.length, serviceFailures: report.serviceFailures, reviewedSeqUnchanged: report.reviewedSeqUnchanged }));
