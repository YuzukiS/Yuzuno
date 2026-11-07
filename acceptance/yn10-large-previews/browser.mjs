// YN-10: the 6.6 MB page lab.py attached on Home opens in the Portal and runs
// to its end, in Chromium, against that lab Core: in English and in Chinese
// (zh-Hans, by the browser's language), 1440 and 390 px wide, with a
// screenshot of each.
//   node browser.mjs <lab.json> <out dir>
// Not covered: the phone entry, Safari, an iPhone.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "../../web/node_modules/playwright-core/index.mjs";

const lab = JSON.parse(await readFile(process.argv[2], "utf8"));
const out = process.argv[3];
await mkdir(out, { recursive: true });
const report = { task: "YN-10", checks: [], screenshots: [], failed: null, passed: false };
// The Portal's own words for each language (web/src/portal/Portal.tsx).
const words = {
  "en-US": { close: "Close preview", refused: "This file can't be previewed" },
  "zh-CN": { close: "关闭预览", refused: "这个文件无法预览" },
};
const runs = [
  { name: "en-1440", locale: "en-US", viewport: { width: 1440, height: 900 } },
  { name: "en-390", locale: "en-US", viewport: { width: 390, height: 844 } },
  { name: "zh-Hans-1440", locale: "zh-CN", viewport: { width: 1440, height: 900 } },
  { name: "zh-Hans-390", locale: "zh-CN", viewport: { width: 390, height: 844 } },
];

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
try {
  for (const run of runs) {
    const context = await browser.newContext({ viewport: run.viewport, locale: run.locale, reducedMotion: "reduce" });
    const page = await context.newPage();
    const minted = [];
    page.on("response", async (response) => {
      if (response.url().endsWith("/api/previews") && response.request().method() === "POST") {
        minted.push({ status: response.status(), body: await response.json().catch(() => null) });
      }
    });
    await page.goto(lab.page);
    // Home: the first of the toolbar's views, at every width and in every language.
    await page.locator(".toolbar-nav .catchup-nav").first().click({ timeout: 20_000 });
    const card = page.locator(`[id="home-section-${lab.projectId}-${lab.section}"]`);
    await card.waitFor({ timeout: 20_000 });
    await card.scrollIntoViewIfNeeded();
    // The attachment's main open button; its ▾ beside it shares the class.
    await card.locator(".brief-attachment .open-choice-split .primary-button").first().click();
    // The page's last script, at the very end of the file, ran.
    const end = page.frameLocator("iframe.portal-frame").locator("#end");
    await end.filter({ hasText: "ran to the end" }).waitFor({ timeout: 60_000 });
    assert.equal(minted.length, 1, `${run.name}: one preview asked for`);
    const [{ status, body }] = minted;
    assert.equal(status, 200, `${run.name}: ${JSON.stringify(body)}`);
    assert.equal(body.size, lab.pageBytes, `${run.name}: the whole page was kept`);
    assert.equal(body.sha256, lab.pageSha256, `${run.name}: as it was attached`);
    // The Portal speaks this run's language, and says nothing was refused.
    await page.getByRole("button", { name: words[run.locale].close }).first().waitFor({ timeout: 10_000 });
    assert.equal(await page.getByText(words[run.locale].refused).count(), 0, `${run.name}: no refusal shown`);
    const shot = `${run.name}.png`;
    await page.screenshot({ path: join(out, shot) });
    report.screenshots.push(shot);
    report.checks.push({ name: `${run.name}: the 6.6 MB page opened from Home and ran to its end`,
      size: body.size, sha256: body.sha256, frame: await end.textContent() });
    console.log(`PASS ${run.name}`);
    await context.close();
  }
  report.passed = true;
} catch (error) {
  report.failed = String(error?.stack || error);
  console.error(report.failed);
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 1));
}
