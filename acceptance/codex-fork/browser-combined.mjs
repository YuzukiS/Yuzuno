// Read-only smoke of the combined build (fork + Machines) on the lab Core.
// Sends no fork, message or Turn; the earlier fork must not be repeated.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { chromium } = await import(pathToFileURL(path.join(root, "web/node_modules/playwright-core/index.mjs")));
const lab = path.join(root, "target/fork-lab");
await mkdir(path.join(lab, "browser"), { recursive: true });
const source = JSON.parse(await readFile(path.join(lab, "state/source.json"), "utf8"));
const base = "http://127.0.0.1:4347";
const workspace = await (await fetch(`${base}/api/workspace`)).json();
const agent = workspace.agents.find((a) => a.threadId === source.threadId);
const report = { checks: [], writes: [] };
const check = (name, ok) => {
  report.checks.push({ name, ok });
  if (!ok) throw new Error(name);
};
const browser = await chromium.launch({ executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("request", (r) => r.method() !== "GET" && report.writes.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await page.addInitScript((id) => localStorage.setItem("yuzuno.selected", JSON.stringify(id)), agent.id);
  await page.goto(`${base}/?shell=desktop`);
  await page.getByText("This conversation continues in", { exact: false }).waitFor();
  check("source shows its continuation on the combined build", true);
  await page.screenshot({ path: path.join(lab, "browser/5-combined-source.png") });
  await page.locator(".codex-writer-notice").getByRole("button", { name: "Open" }).click();
  await page.waitForFunction((id) => JSON.parse(localStorage.getItem("yuzuno.selected") || "null") !== id, agent.id);
  check("Open selects the fork, which has no conflict notice",
    (await page.getByText("Another Codex client still owns this session", { exact: false }).count()) === 0);
  await page.screenshot({ path: path.join(lab, "browser/6-combined-fork.png") });
  // Machines lives in the project switcher menu at the bottom of the rail.
  await page.locator(".project-switcher button").first().click();
  await page.getByRole("menuitem", { name: "Machines…" }).click();
  await page.getByRole("dialog").or(page.locator("[title='Machines']")).first().waitFor();
  check("Machines page still opens alongside the fork", true);
  await page.screenshot({ path: path.join(lab, "browser/7-combined-machines.png") });
  check("no fork, message or turn was sent", !report.writes.some((w) => /\/(codex\/fork|messages|turns)$/.test(w)));
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error?.message || error);
} finally {
  await browser.close();
  await writeFile(path.join(lab, "browser-combined-report.json"), JSON.stringify(report, null, 2));
  console.log(`${report.status}: ${report.checks.length} checks; writes ${JSON.stringify(report.writes)}${report.error ? `; ${report.error}` : ""}`);
}
