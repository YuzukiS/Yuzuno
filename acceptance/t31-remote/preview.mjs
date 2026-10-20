// Actual image history on the isolated acceptance Core; never a daily window.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const require = createRequire(new URL("../../web/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const run = resolve(process.argv[2]);
assert.ok(run.includes("/target/t31-remote/native-"));
const report = JSON.parse(await readFile(resolve(run, "report.json"), "utf8"));
assert.ok(report.port > 0 && report.port !== 4317);
const browser = await chromium.launch({ executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium", headless: true });
const evidence = [];
try {
  for (const agent of report.agents) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript((id) => localStorage.setItem("yuzuno.selected", id), agent.id);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${report.port}`);
    console.log(agent.harness, "history loaded");
    const images = page.locator(".user-message .input-image-open");
    await images.first().waitFor({ timeout: 30000 });
    // History opens at its bottom. The first thumbnail is deliberately lazy:
    // bring it into view before waiting for its bytes to decode.
    await images.first().scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector(".user-message .input-image-open > img")?.naturalWidth > 0);
    console.log(agent.harness, "thumbnail loaded");
    await images.first().click();
    const original = page.locator(".input-image-dialog img");
    await original.waitFor();
    await page.waitForFunction(() => document.querySelector(".input-image-dialog img")?.naturalWidth > 0);
    const size = await original.evaluate((image) => [image.naturalWidth, image.naturalHeight]);
    console.log(agent.harness, "original loaded", size);
    assert.ok(size[0] === 700 || size[0] === 3000);
    assert.match(await original.getAttribute("src"), new RegExp(`/agents/${agent.id}/images/`));
    await page.screenshot({ path: resolve(run, `${agent.harness}-original-preview.png`) });
    await page.keyboard.press("Escape");
    await page.reload();
    await images.first().waitFor();
    await images.first().click();
    await page.waitForFunction(() => document.querySelector(".input-image-dialog img")?.naturalWidth > 0);
    const reloadedSize = await original.evaluate((image) => [image.naturalWidth, image.naturalHeight]);
    assert.deepEqual(reloadedSize, size);
    console.log(agent.harness, "original reloaded", reloadedSize);
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    evidence.push({ harness: agent.harness, agentId: agent.id, originalSize: size, reloadPreview: true, pageErrors: errors });
    await context.close();
  }
  await writeFile(resolve(run, "preview.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await browser.close();
}
