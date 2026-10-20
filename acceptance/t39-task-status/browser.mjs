#!/usr/bin/env node
// T-39: the user decides a task status proposal a real Agent published, in
// Chromium on a lab Core:
//
//   node browser.mjs <lab Core URL> <Agent id> <step> <screenshot folder>
//
// confirm  T-1's proposal: another window changes T-1 first, so the first
//          confirmation (keyboard) is refused as stale; the user then picks
//          another status and writes a reason, Core's answer to the next
//          confirmation is lost on the way back, and "Check again" sends the
//          same decision once more. A second window then sees the outcome.
//          Light 1280 px, then dark 390 px.
// decline  T-2's proposal: declined with the keyboard.
// declined T-2's proposal, read only: what a window opened afterwards shows.
//
// Prints one JSON line of what the page showed and sent; live.py judges it.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(new URL("../../web/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const [base, agent, step, shots] = process.argv.slice(2);
if (!shots) {
  console.error("usage: node browser.mjs <lab Core URL> <Agent id> confirm|decline <screenshot folder>");
  process.exit(2);
}
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const out = { step, posts: [], errors: [] };

async function open(context, theme) {
  const page = await context.newPage();
  page.on("pageerror", (error) => out.errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/task-status"))
      out.posts.push(JSON.parse(request.postData() || "{}"));
  });
  await page.addInitScript(([id, value]) => {
    localStorage.setItem("yuzuno.selected", JSON.stringify(id));
    localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: value }));
  }, [agent, theme]);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  // The newest proposal is the last card in the conversation.
  const card = page.locator(".task-status-card").last();
  await card.waitFor({ timeout: 30000 });
  await card.scrollIntoViewIfNeeded();
  // Core's facts have been read.
  await card.locator(".task-status-facts dd").first().filter({ hasNotText: "Reading the task" }).waitFor();
  return { page, card };
}
const read = async (card) => ({
  text: (await card.textContent()).replace(/\s+/g, " ").trim(),
  buttons: (await card.locator("button").allTextContents()).map((b) => b.trim()),
});
async function press(page, card, label) {
  const button = card.getByRole("button", { name: label, exact: true });
  await button.focus();
  await page.keyboard.press("Enter");
}
async function api(page, operation, body) {
  return page.evaluate(async ([operation, body]) => {
    const response = await fetch(`/api/collaboration/${operation}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Yuzuno-Client": "desktop" }, body: JSON.stringify(body),
    });
    return response.json();
  }, [operation, body]);
}

try {
  if (step === "confirm") {
    const light = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
    const { page, card } = await open(light, "light");
    out.first = await read(card);
    await page.screenshot({ path: join(shots, "proposal-light.png") });
    // Another window changes T-1 after this one read it.
    const before = (await api(page, "task_get", { taskId: "T-1" })).task;
    out.elsewhere = (await api(page, "task_update", { requestId: "elsewhere-1", taskId: "T-1", expectedVersion: before.version,
      patch: { progress: "Another window wrote this" } })).task;
    await press(page, card, out.first.buttons[0]);
    await card.locator("[role=alert]", { hasText: "changed while you were deciding" }).waitFor();
    out.stale = await read(card);
    // The user changes the proposal: blocked, with their own reason.
    await card.locator("select").selectOption("blocked");
    const reason = card.locator("textarea");
    await reason.focus();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("Waits for the second-host install check");
    out.edited = await read(card);
    // Core applies the next confirmation, but its answer never reaches the page.
    let lost = 0;
    await page.route("**/task-status", async (route) => {
      if (route.request().method() !== "POST" || lost++) return route.continue();
      await route.fetch();
      await route.abort("connectionreset");
    });
    await press(page, card, "Change T-1 to Blocked");
    await card.locator("[role=alert]", { hasText: "was lost" }).waitFor();
    out.lost = await read(card);
    await page.unroute("**/task-status");
    await press(page, card, "Check again");
    await card.locator(".task-status-outcome", { hasText: "confirmed it" }).waitFor();
    out.applied = await read(card);
    await page.screenshot({ path: join(shots, "applied-light.png") });
    // A second window opened afterwards shows the same outcome.
    const second = await open(light, "light");
    out.secondWindow = await read(second.card);
    await light.close();
    const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    const narrow = await open(dark, "dark");
    const box = await narrow.card.boundingBox();
    out.narrow = {
      theme: await narrow.page.evaluate(() => document.documentElement.dataset.theme),
      overflow: await narrow.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      fits: Boolean(box && box.x >= 0 && box.x + box.width <= 390),
      ...(await read(narrow.card)),
    };
    await narrow.page.screenshot({ path: join(shots, "applied-dark-narrow.png") });
    await dark.close();
  } else if (step === "decline") {
    const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    const { page, card } = await open(dark, "dark");
    out.first = await read(card);
    await page.screenshot({ path: join(shots, "decline-dark-narrow.png") });
    await press(page, card, "Decline");
    await card.locator(".task-status-outcome", { hasText: "declined it" }).waitFor();
    out.declined = await read(card);
    await dark.close();
  } else if (step === "declined") {
    const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    const { page, card } = await open(dark, "dark");
    await card.locator(".task-status-outcome", { hasText: "declined it" }).waitFor();
    out.declined = await read(card);
    const box = await card.boundingBox();
    out.narrow = {
      theme: await page.evaluate(() => document.documentElement.dataset.theme),
      overflow: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      fits: Boolean(box && box.x >= 0 && box.x + box.width <= 390),
      // The card's own styles are applied (a grid, from intelligent-ui.css).
      styled: await card.evaluate((node) => getComputedStyle(node).display === "grid"),
    };
    await page.screenshot({ path: join(shots, "declined-dark-narrow.png") });
    await dark.close();
  } else {
    throw new Error(`unknown step ${step}`);
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(out));
