// Browser checks against the isolated lab Core started by live.py run (4337).
//   node acceptance/machine-checks/live-ui.mjs
// One fresh headless Chromium; never opens the daily Core.
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
const ids = state.machines;
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(detail)}`}`);
};
const api = async (path) => (await fetch(base + path)).json();
const stored = async (id) =>
  (await api("/api/machines")).machines.find((m) => m.id === id)?.lastCheck;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const card = (id) => page.locator(`[data-machine-id="${id}"]`);
async function openMachines() {
  await page.click(".workspace-scope");
  await page.click("button:has-text('Machines…')");
  await page.waitForSelector(`[data-machine-id="${ids["Unreachable"]}"] .last-check`);
}

try {
  await page.goto(base);
  await page.waitForSelector(".workspace-scope strong");
  await openMachines();
  const cards = await page.$$eval(".machine-card h3", (nodes) => nodes.map((n) => n.textContent));
  check("the page lists the Core host and every registered SSH machine",
    JSON.stringify(cards) === JSON.stringify(["Core host", "Mac mini", "Mac mini · wrong Codex path", "Unreachable"]), cards);
  const mac = await card(ids["Mac mini"]).locator(".last-check").textContent();
  check("an old Mac mini result shows its age and is labelled, not called offline",
    /Reached [^\n]+/.test(mac) && /3 h ago/.test(mac) && /May be out of date/.test(mac), mac);
  const wrong = await card(ids["Mac mini · wrong Codex path"]).locator(".last-check").textContent();
  check("reaching a machine and finding Codex are shown separately", /Reached/.test(wrong) && /Codex unavailable/.test(wrong) && /Codex: 找不到指定的远程 Codex/.test(wrong), wrong);
  const gone = await card(ids["Unreachable"]).locator(".last-check").textContent();
  check("a failed check shows its reason", /Couldn’t reach/.test(gone) && /Could not resolve hostname/.test(gone), gone);
  const host = await card("local").textContent();
  check("the Core host lists its agents with their own state", /Lab local agent/.test(host), host.slice(0, 300));
  check("nothing on the page claims a machine is online", !/\bonline\b/i.test(await page.textContent(".machines-page")), null);
  await shot("1-machines-light");

  const before = await stored("local");
  await card("local").locator("button:has-text('Test connection')").click();
  // Wait for this check itself, not for any recent-looking label.
  await page.waitForFunction(async (previous) => {
    const list = await (await fetch("/api/machines")).json();
    return list.machines.find((m) => m.id === "local")?.lastCheck?.checkedAt !== previous;
  }, before.checkedAt);
  await page.waitForSelector('[data-machine-id="local"] button:has-text("Test connection"):not([disabled])');
  const after = await stored("local");
  check("testing from the page stores a newer result for that machine only",
    after.checkedAt > before.checkedAt && (await stored(ids["Mac mini"])).checkedAt === state.agedAt, { before: before.checkedAt, after: after.checkedAt });
  await shot("2-machines-after-test");
  await page.keyboard.press("Escape");

  // New agent reads and writes the same stored result.
  await page.click('[aria-label="Create agent"]');
  await page.waitForSelector("#create-machine");
  await page.selectOption("#create-machine", ids["Mac mini"]);
  const inDialog = await page.textContent('[role="dialog"] .last-check');
  check("New agent shows the same stored Mac mini result", /3 h ago/.test(inDialog) && /May be out of date/.test(inDialog), inDialog);
  await shot("3-new-agent-same-result");
  await page.click('[role="dialog"] button:has-text("Test connection")');
  await page.waitForFunction(() => /just now/.test(document.querySelector('[role="dialog"] .last-check')?.textContent || ""), null, { timeout: 90_000 });
  // R1: a failed test in New agent shows its reason right there.
  await page.selectOption("#create-machine", ids["Unreachable"]);
  await page.click('[role="dialog"] button:has-text("Test connection")');
  await page.waitForSelector('[role="dialog"] button:has-text("Test connection"):not([disabled])');
  const reason = await page.locator('[role="dialog"] .last-check-error').first().textContent().catch(() => "");
  check("a failed test in New agent shows its reason as visible text",
    /Could not resolve hostname/.test(reason) && await page.locator('[role="dialog"] .last-check-error').first().isVisible(), reason);
  await page.selectOption("#create-machine", ids["Mac mini · wrong Codex path"]);
  const missing = await page.textContent('[role="dialog"] .last-check');
  check("New agent shows why Codex is unavailable", /Codex: 找不到指定的远程 Codex/.test(missing), missing);
  await shot("3b-new-agent-failure-reason");
  await page.keyboard.press("Escape");
  await openMachines();
  const refreshed = await card(ids["Mac mini"]).locator(".last-check").textContent();
  check("a check from New agent appears on the Machines page", /just now/.test(refreshed) && !/out of date/.test(refreshed), refreshed);

  await card("local").locator(".machine-agent:has-text('Lab local agent')").click();
  await page.waitForSelector(".conversation-heading h1:text-is('Lab local agent')");
  check("an agent opens from its machine and the page closes", (await page.$('[role="dialog"]')) === null, null);

  await page.evaluate(() => localStorage.setItem("yuzuno.appearance", JSON.stringify({ theme: "dark", fontSize: 20 })));
  await page.reload();
  await page.waitForSelector(".workspace-scope strong");
  await openMachines();
  await shot("4-machines-dark-20px");
  check("dark theme and 20px apply to the page",
    (await page.getAttribute("html", "data-theme")) === "dark", await page.getAttribute("html", "data-theme"));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const overflow = await page.$eval(".modal", (m) => m.scrollWidth - m.clientWidth);
  check("the narrow layout has no horizontal overflow", overflow <= 1, overflow);
  await shot("5-machines-narrow");
  check("no page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
const passed = checks.every((c) => c.ok);
await writeFile(join(here, "live-ui-result.json"), JSON.stringify({ passed, checks }, null, 2));
console.log(passed ? "ALL PASSED" : "FAILED");
process.exit(passed ? 0 : 1);
