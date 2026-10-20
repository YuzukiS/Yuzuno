import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const output = process.env.YUZUNO_APPEARANCE_OUTPUT
  ? resolve(process.env.YUZUNO_APPEARANCE_OUTPUT)
  : fileURLToPath(new URL("../../acceptance/appearance", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
  colorScheme: "light",
});
const page = await context.newPage();
await page.emulateMedia({ reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const report = {
  mode: "explicit-readonly-preview",
  checks: [],
  browserErrors: errors,
};
const state = () =>
  page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    font: document.documentElement.dataset.fontSize,
    body: getComputedStyle(document.querySelector(".prose")).fontSize,
    input: getComputedStyle(document.querySelector(".composer textarea"))
      .fontSize,
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
// Appearance is a category of Settings.
async function openAppearance() {
  await page.getByRole("button", { name: "Settings and updates" }).click();
  await page.getByRole("tab", { name: "Appearance" }).click();
}
async function closeSettings() {
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
}
try {
  await page.goto(
    `${process.env.YUZUNO_CORE_URL || "http://127.0.0.1:4317"}/?preview=1&shell=desktop`,
  );
  await page.getByRole("button", { name: "Settings and updates" }).waitFor();
  assert.equal((await state()).body, "16px");
  assert.equal((await state()).input, "16px");
  await openAppearance();
  await page.screenshot({ path: resolve(output, "appearance-light.png") });
  await page.getByRole("radio", { name: /Dark Evening garden/ }).check();
  assert.equal((await state()).theme, "dark");
  await page.getByRole("radio", { name: "20 px" }).check();
  assert.equal((await state()).body, "20px");
  await closeSettings();
  await page.reload();
  await page.locator(".prose").first().waitFor();
  assert.equal((await state()).theme, "dark");
  assert.equal((await state()).body, "20px");
  report.checks.push("theme and 20px reading size persist after reload");
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal((await state()).theme, "dark");
  report.checks.push("explicit dark ignores system light");
  await openAppearance();
  await page.getByRole("radio", { name: /System Follow your device/ }).check();
  assert.equal((await state()).theme, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  report.checks.push("system preference follows OS changes without reload");
  await page.getByRole("radio", { name: "18 px" }).check();
  await page.screenshot({ path: resolve(output, "appearance-dark.png") });
  await closeSettings();
  await page.screenshot({ path: resolve(output, "workspace-dark.png") });
  for (const width of [1440, 940, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await openAppearance();
    await page.getByRole("radio", { name: "20 px" }).check();
    const layout = await state();
    assert.ok(layout.scrollWidth <= width, `page overflow at ${width}`);
    const dialog = await page.getByRole("dialog").boundingBox();
    assert.ok(
      dialog.x >= 0 && dialog.x + dialog.width <= width,
      `dialog overflow at ${width}`,
    );
    await page.screenshot({ path: resolve(output, `settings-${width}.png`) });
    await closeSettings();
    await page.screenshot({ path: resolve(output, `workspace-${width}.png`) });
    report.checks.push({
      viewport: width,
      fontSize: 20,
      noHorizontalOverflow: true,
    });
  }
  assert.deepEqual(errors, []);
} finally {
  await writeFile(
    resolve(output, "appearance-report.json"),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
