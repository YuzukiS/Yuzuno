// T-107: the pause controls in a real browser against an isolated lab Core
// (ui_lab.py starts it, with one running fixture job). Clicks the job's
// Pause, waits for the confirmed Paused state, takes light, dark and 390 px
// screenshots, then Resume. Usage: BASE=http://127.0.0.1:4594 OUT=dir JOB=name node ui_shots.mjs
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = createRequire(resolve(root, "web/package.json"))("playwright-core");
const base = process.env.BASE;
const out = resolve(process.env.OUT);
const name = process.env.JOB;
assert.match(base, /^http:\/\/127\.0\.0\.1:45\d\d$/, "lab ports only");
await mkdir(out, { recursive: true });
const report = { checks: [], screenshots: [], errors: [] };
const check = (what, ok, detail) => {
  report.checks.push({ check: what, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${what}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
};

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
try {
  const open = async (theme, width) => {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    page.on("pageerror", (e) => report.errors.push(e.message));
    await page.addInitScript((t) => {
      localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: t, fontSize: 18, palette: "garden" }));
    }, theme);
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Jobs", exact: true }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator(".job-row", { hasText: name }).first().click();
    await dialog.locator(".job-detail-heading h3", { hasText: name }).waitFor();
    return { page, dialog };
  };
  const shot = async (page, file) => {
    await page.screenshot({ path: resolve(out, file) });
    report.screenshots.push(file);
  };
  const heading = (dialog) => dialog.locator(".job-detail-heading .job-state").innerText();

  const { page, dialog } = await open("light", 1440);
  check("the running job offers Pause beside Cancel", (await dialog.getByRole("button", { name: "Pause", exact: true }).count()) === 1
    && (await dialog.getByRole("button", { name: "Cancel", exact: true }).count()) === 1);
  await shot(page, "1-running-light.png");
  await dialog.getByRole("button", { name: "Pause", exact: true }).click();
  await dialog.locator(".job-detail-heading .job-state", { hasText: "Paused" }).waitFor({ timeout: 20000 });
  const note = await dialog.locator(".job-pause-note").innerText();
  check("after the click the job reads Paused, with what it keeps and when its timeout stops it",
    /^Paused/.test(await heading(dialog)) && note.includes("Memory and GPU memory stay reserved; only you can resume it.")
      && note.includes("The timeout still counts: it stops at"), { heading: await heading(dialog), note });
  check("its row is drawn paused", (await dialog.locator(".job-row .status-mark.state-paused").count()) >= 1);
  // The panel reloads after the click; shoot once its buttons are usable again.
  await dialog.getByRole("button", { name: "Resume", exact: true }).and(dialog.locator(":enabled")).waitFor();
  await shot(page, "2-paused-light.png");

  const dark = await open("dark", 1440);
  check("dark theme shows the same paused state", /^Paused/.test(await heading(dark.dialog)));
  await shot(dark.page, "3-paused-dark.png");
  const narrow = await open("light", 390);
  check("a 390 px window shows the paused state", /^Paused/.test(await heading(narrow.dialog)));
  const overflow = await narrow.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no sideways overflow at 390 px", overflow <= 0, { overflow });
  await shot(narrow.page, "4-paused-390.png");

  await dialog.getByRole("button", { name: "Resume", exact: true }).click();
  await dialog.locator(".job-detail-heading .job-state", { hasText: "Running" }).waitFor({ timeout: 20000 });
  check("Resume returns it to Running and the pause note goes", (await dialog.locator(".job-pause-note").count()) === 0);
  await shot(page, "5-resumed-light.png");
  check("no page errors", report.errors.length === 0, report.errors);
} finally {
  await browser.close();
  await writeFile(resolve(out, "ui-shots.json"), JSON.stringify(report, null, 1));
}
const failed = report.checks.filter((c) => !c.ok).length;
console.log(`${report.checks.length - failed}/${report.checks.length} passed`);
process.exit(failed ? 1 : 0);
