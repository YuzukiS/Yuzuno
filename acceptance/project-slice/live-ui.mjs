// Browser checks against the isolated lab Core started by live.py (port 4337).
// Run from the repository root after `live.py seed`:
//   node acceptance/project-slice/live-ui.mjs
// Uses a fresh headless Chromium profile; never opens the daily Core.
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../web/package.json"));
const { chromium } = require("playwright-core");
const base = "http://127.0.0.1:4337";
const shots = join(here, "screenshots");
await mkdir(shots, { recursive: true });
const state = JSON.parse(await readFile(join(here, "live-state.json"), "utf8"));
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(detail)}`}`);
};
const api = async (path) => (await fetch(base + path)).json();
const readState = async () =>
  Object.fromEntries(
    (await api("/api/workspace")).agents.map((a) => [
      a.name,
      { reviewedSeq: a.reviewedSeq, unread: a.unreadCount, pending: a.pendingCount },
    ]),
  );

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
// Settled screenshots, as the existing browser checks take them.
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const railNames = () =>
  page.$$eval(".agent-list .agent-name", (nodes) => nodes.map((n) => n.textContent));
async function scope(name) {
  await page.click(".workspace-scope");
  await page.click(`.scope-menu [role="menuitemradio"]:has(.scope-option-name:text-is("${name}"))`);
  await page.waitForTimeout(150);
}

try {
  await page.goto(base);
  await page.waitForSelector(".workspace-scope strong");
  // The initial automatic selection is existing behaviour; measure only switches.
  await page.waitForTimeout(2500);
  const before = await readState();

  await scope("App");
  check("App shows both of its agents, including the external worktree", JSON.stringify(await railNames()) === '["Main","Hotfix"]', await railNames());
  const notice = await page.textContent(".elsewhere-notice").catch(() => null);
  check("a real request in Research is surfaced from App", /1 waiting in other projects/.test(notice || ""), notice);
  await shot("1-scope-app");
  await page.click(".workspace-scope");
  await shot("2-scope-menu");
  await page.keyboard.press("Escape");

  await scope("Research");
  await page.waitForTimeout(2000);
  check("Research shows only Reader", JSON.stringify(await railNames()) === '["Reader"]', await railNames());
  check("leaving the open agent's project shows Catch-up, not another conversation",
    (await page.$(".catchup-view")) !== null, null);
  await scope("No project");
  await page.waitForTimeout(2000);
  await scope("App");
  await page.waitForTimeout(2000);
  const after = await readState();
  check("scope switches produced no reads", JSON.stringify(before) === JSON.stringify(after), { before, after });

  await page.click(".elsewhere-notice");
  await page.waitForSelector(".catchup-view");
  const catchup = await page.textContent(".catchup-view");
  check("Catch-up lists the request under Waiting in other projects",
    /Waiting in other projects/.test(catchup) && /Reader/.test(catchup), catchup.slice(0, 400));
  await shot("3-catchup-elsewhere");
  await page.click('.catchup-group:has(h2:text("Waiting in other projects")) .catchup-item');
  await page.waitForSelector(".conversation-heading h1:text-is('Reader')");
  await page.waitForTimeout(400);
  const scopeLabel = await page.textContent(".workspace-scope strong");
  const approval = await page.$("[id^='request-']");
  check("opening it moves the window to Research and shows the approval", scopeLabel === "Research" && approval !== null, scopeLabel);
  await shot("4-reader-approval");

  await scope("App");
  await page.click("button:has-text('Tasks & messages')");
  await page.waitForSelector(".collab-task-card");
  const card = await page.textContent(".collab-task-card");
  check("App's board shows the task Main created, owned by Reader in Research",
    /Review the hotfix notes/.test(card) && /Reader/.test(card), card);
  await shot("5-tasks-app");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await page.click(".workspace-scope");
  await shot("6-compact-menu");
  check("the entry stays reachable in the compact layout", await page.isVisible(".scope-menu"), null);
  await page.keyboard.press("Escape");

  // Look only: open the dialogs without submitting anything.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForTimeout(200);
  await page.click(".workspace-scope");
  await page.click("button:has-text('Manage projects')");
  await page.waitForSelector(".project-manager");
  await shot("7-projects-dialog");
  await page.keyboard.press("Escape");
  await page.click('[aria-label="Create agent"]');
  await page.waitForSelector('select[aria-label="Project"]');
  check("New agent starts in the viewed project",
    (await page.inputValue('select[aria-label="Project"]')) === state.projects.app, null);
  await shot("8-new-agent-in-project");
  await page.keyboard.press("Escape");
  check("no page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
const passed = checks.every((c) => c.ok);
await writeFile(join(here, "live-ui-result.json"), JSON.stringify({ passed, checks, seed: state.seed?.checks }, null, 2));
console.log(passed ? "ALL PASSED" : "FAILED");
process.exit(passed ? 0 : 1);
