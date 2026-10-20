// T-4 GUI acceptance on the isolated lab Core (4347) with real Codex.
// Draft protection, cancel without effect, one fork from a double click,
// then the continuation link on the source. Only these writes are allowed:
// the fork preview and one fork request. Messages and turns must not be sent.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { chromium } = await import(pathToFileURL(path.join(root, "web/node_modules/playwright-core/index.mjs")));
const lab = path.join(root, "target/fork-lab");
const shots = path.join(lab, "browser");
await mkdir(shots, { recursive: true });
const source = JSON.parse(await readFile(path.join(lab, "state/source.json"), "utf8"));
const base = "http://127.0.0.1:4347";
const headers = { "content-type": "application/json", "x-yuzuno-client": "desktop" };
const api = async (p) => (await fetch(`${base}/api${p}`, { headers })).json();
const agent = (await api("/workspace")).agents.find((a) => a.threadId === source.threadId);
const draft = "A draft written before the fork; it must never be sent.";
const report = { checks: [], writes: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, ...(detail ? { detail: structuredClone(detail) } : {}) });
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
};

const browser = await chromium.launch({ executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("request", (request) => {
    if (request.method() !== "GET") report.writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.addInitScript((id) => localStorage.setItem("yuzuno.selected", JSON.stringify(id)), agent.id);
  await page.goto(`${base}/?shell=desktop`);
  const composer = page.getByLabel(`Message ${agent.name}`, { exact: true });
  await composer.fill(draft);
  const notice = page.getByText("Another Codex client still owns this session", { exact: false });
  await notice.waitFor();
  check("conflict is explained on the source", true);
  await page.screenshot({ path: path.join(shots, "1-conflict.png") });

  await page.getByRole("button", { name: "Continue in a fork…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Copies 2 turns").waitFor();
  const text = await dialog.innerText();
  check("dialog names the boundary and what is created", /History up to and including the latest completed turn/.test(text)
    && /new native session/.test(text) && /new agent/.test(text) && /nothing is closed for you/.test(text), text);
  await page.screenshot({ path: path.join(shots, "2-dialog.png") });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached" });
  const afterCancel = await api(`/agents/${agent.id}`);
  check("cancel changes nothing", !afterCancel.codexHandoff?.forkedTo
    && !report.writes.some((w) => w.endsWith("/codex/fork")), report.writes);

  await page.getByRole("button", { name: "Continue in a fork…" }).click();
  await dialog.getByText("Copies 2 turns").waitFor();
  const fork = dialog.getByRole("button", { name: "Fork and continue" });
  await fork.click();
  await fork.click({ force: true, timeout: 1000 }).catch(() => {});
  await dialog.waitFor({ state: "detached", timeout: 180000 });
  const linked = (await api(`/agents/${agent.id}`)).codexHandoff?.forkedTo;
  check("one fork request despite a double click", report.writes.filter((w) => w.endsWith("/codex/fork")).length === 1, report.writes);
  check("the source links to its continuation", !!linked, linked);
  const forkComposer = page.getByLabel(`Message ${agent.name}`, { exact: true });
  await page.waitForFunction((id) => JSON.parse(localStorage.getItem("yuzuno.selected") || "null") === id, linked.agentId);
  check("the new agent is selected with the draft copied", (await forkComposer.inputValue()) === draft);
  check("nothing was sent", !report.writes.some((w) => /\/(messages|turns)$/.test(w)), report.writes);
  await page.screenshot({ path: path.join(shots, "3-fork-selected.png") });

  await page.evaluate((id) => localStorage.setItem("yuzuno.selected", JSON.stringify(id)), agent.id);
  await page.reload();
  await page.getByText("This conversation continues in", { exact: false }).waitFor();
  check("source shows where it continues; original draft kept",
    (await page.getByLabel(`Message ${agent.name}`, { exact: true }).inputValue()) === draft);
  await page.screenshot({ path: path.join(shots, "4-source-continued.png") });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error?.message || error);
} finally {
  await browser.close();
  await writeFile(path.join(lab, "browser-report.json"), JSON.stringify(report, null, 2));
  console.log(`${report.status}: ${report.checks.length} checks; writes ${JSON.stringify(report.writes)}`);
}
