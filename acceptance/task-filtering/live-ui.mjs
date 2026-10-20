// One short headless Chromium against the lab Core from live.py run (4393).
//   node acceptance/task-filtering/live-ui.mjs
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../web/package.json"));
const { chromium } = require("playwright-core");
const base = "http://127.0.0.1:4393";
const shots = join(here, "screenshots");
await mkdir(shots, { recursive: true });
const state = JSON.parse(await readFile(join(here, "live-state.json"), "utf8"));
const { mori, hana } = state.agents;
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(detail)}`}`);
};
const post = (path, body) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Yuzuno-Client": "desktop" },
    body: JSON.stringify(body ?? {}) }).then((r) => r.json());

const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium" });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const cards = () => page.$$eval(".collab-task-card", (nodes) => nodes.map((n) => n.dataset.taskId));
const filter = (label) => page.locator(`.collab-filters label:has(span:text-is("${label}")) select`);
const text = () => page.textContent(".collab-task-list");
const waitCards = (n) => page.waitForFunction((n) => document.querySelectorAll(".collab-task-card").length === n, n);

try {
  await page.goto(base);
  await page.waitForSelector(".workspace-scope strong");
  await page.click("button:has-text('Tasks & messages')");
  await page.waitForSelector(".collab-task-card");

  await filter("Owner").selectOption(hana);
  await waitCards(1);
  check("Hana's only open task, #140, appears without loading more",
    JSON.stringify(await cards()) === '["T-140"]' && /Showing 1 of 1 matching tasks/.test(await text()), await cards());
  await shot("1-owner-hana");

  await filter("Owner").selectOption(mori);
  await waitCards(100);
  check("Mori's first page reports the full total", /Showing 100 of 137 matching tasks/.test(await text()), await text());
  await page.click("button:has-text('Load more tasks')");
  await waitCards(137);
  const both = await cards();
  check("two pages hold all 137 matches once, in order", JSON.stringify(both) === JSON.stringify(state.expectedMori), both.length);
  await shot("2-two-pages");

  // A real unrelated Core broadcast (a machine check) must not drop page 2.
  await post("/api/machines/local/check");
  await page.waitForTimeout(2500);
  check("an unrelated workspace event keeps both pages without a notice",
    (await cards()).length === 137 && !/Tasks changed/.test(await text()), (await cards()).length);

  // A real edit to a task on the second page.
  const target = state.expectedMori[120];
  const current = (await post("/api/collaboration/task_get", { taskId: target })).task;
  await post("/api/collaboration/task_update", { requestId: "live-rename", taskId: target,
    expectedVersion: current.version, patch: { title: "Renamed on page two" } });
  await page.waitForSelector("text=Tasks changed since these pages loaded", { timeout: 10_000 });
  check("an edit on page two is announced and nothing is dropped", (await cards()).length === 137, (await cards()).length);
  const list = await page.locator(".collab-task-list").boundingBox();
  const notice = await page.locator(".collab-outdated").boundingBox();
  const scrolled = await page.$eval(".collab-task-list", (el) => el.scrollTop);
  check("the notice stays in view while reading later pages",
    scrolled > 0 && notice && notice.y >= list.y - 1 && notice.y + notice.height <= list.y + list.height, { scrolled, notice, list });
  await shot("3-changed-notice");
  await page.click(".collab-outdated button:has-text('Refresh tasks')");
  await waitCards(100);
  check("Refresh starts again from Core's first page", !/Tasks changed/.test(await text()), null);

  // An edit draft survives background updates.
  await page.click(".collab-task-card >> nth=0");
  await page.click("button:has-text('Edit task')");
  const title = page.locator('.collab-detail label:has(span:text-is("Task title")) input');
  await title.fill("Draft kept during updates");
  await post("/api/collaboration/task_comment", { requestId: "live-comment", taskId: state.expectedMori[5], body: "Background activity" });
  await post("/api/machines/local/check");
  await page.waitForTimeout(2500);
  check("an edit draft survives background refreshes", (await title.inputValue()) === "Draft kept during updates", await title.inputValue());
  await page.click(".collab-detail button:has-text('Cancel')").catch(() => {});

  await filter("Project").selectOption(`project:${state.project}`);
  const expectedApp = (await post("/api/collaboration/task_list", { statuses: ["todo", "doing", "blocked", "review"],
    assigneeAgentId: mori, projectId: state.project, limit: 200 })).tasks.map((t) => t.id);
  await waitCards(expectedApp.length);
  check("switching Project starts a fresh list with only that project's matches",
    JSON.stringify(await cards()) === JSON.stringify(expectedApp), { shown: (await cards()).length, expected: expectedApp.length });
  await shot("4-project-app");

  // Rapid switching ends on the last choice only.
  await filter("Project").selectOption("all");
  await filter("Owner").selectOption(mori);
  await filter("Owner").selectOption(hana);
  await filter("Owner").selectOption(mori);
  await filter("Owner").selectOption(hana);
  await page.waitForTimeout(1500);
  check("rapid owner switches settle on the last choice", JSON.stringify(await cards()) === '["T-140"]', await cards());

  // R1: an empty result keeps its button and keyboard focus through the
  // 5 s background reload.
  await filter("Show").selectOption("done");
  await page.waitForSelector("text=No tasks match these filters");
  await page.locator(".collab-empty button:has-text('Create a task')").focus();
  await page.evaluate(() => { window.__createButton = document.activeElement; });
  const reloadsBefore = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.endsWith("/task_list")).length);
  await page.waitForTimeout(7000);
  const reloadsAfter = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.endsWith("/task_list")).length);
  const focus = await page.evaluate(() => ({
    same: document.activeElement === window.__createButton && window.__createButton.isConnected,
    label: document.activeElement?.textContent?.trim(),
  }));
  check("an empty result keeps Create a task focused through background reloads",
    focus.same && reloadsAfter > reloadsBefore, { ...focus, reloadsBefore, reloadsAfter });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await shot("5-narrow");
  check("no page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
const passed = checks.every((c) => c.ok);
await writeFile(join(here, "live-ui-result.json"), JSON.stringify({ passed, checks }, null, 2));
console.log(passed ? "ALL PASSED" : "FAILED");
process.exit(passed ? 0 : 1);
