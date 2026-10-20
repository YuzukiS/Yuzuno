// T-4 R2 on the lab Core (4347) with real Codex, after the R1 fork exists.
// A closed continuation stays linked; once deleted, the source shows its
// conflict again; Cancel writes nothing; one explicit fork recovers. The
// fork Agent is closed and deleted through the API, outside the page, so the
// page's own writes can only be fork previews, the one fork and the existing
// read receipt for the source on screen. Messages and Turns must not be sent.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { chromium } = await import(pathToFileURL(path.join(root, "web/node_modules/playwright-core/index.mjs")));
const lab = path.join(root, "target/fork-lab");
const shots = path.join(lab, "browser");
await mkdir(shots, { recursive: true });
const sourceThread = JSON.parse(await readFile(path.join(lab, "state/source.json"), "utf8")).threadId;
const base = "http://127.0.0.1:4347";
const headers = { "content-type": "application/json", "x-yuzuno-client": "desktop" };
const api = async (p, method = "GET") => {
  const response = await fetch(`${base}/api${p}`, { method, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${p}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
};
const agentsBefore = (await api("/workspace")).agents;
const source = agentsBefore.find((a) => a.threadId === sourceThread);
// A run that stopped after deleting the R1 fork resumes from its report.
const run1 = await readFile(path.join(lab, "browser-r2-run1-report.json"), "utf8").then(JSON.parse, () => null);
const linkedAtStart = (await api(`/agents/${source.id}`)).codexHandoff?.forkedTo?.agentId;
const firstFork = linkedAtStart ?? run1?.checks?.[0]?.detail?.firstFork;
const report = { checks: [], writes: [], apiWrites: [], resumedFromRun1: !linkedAtStart };
// Each check keeps its own copy of the evidence it was decided on.
const check = (name, ok, detail) => {
  report.checks.push({ name, ok, ...(detail ? { detail: structuredClone(detail) } : {}) });
  if (!ok) throw new Error(`${name}: ${JSON.stringify(detail)}`);
};
const forkPosts = () => report.writes.filter((w) => w.endsWith("/codex/fork"));

const browser = await chromium.launch({ executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/sbin/chromium", headless: true });
try {
  check("the R1 fork is the starting continuation", !!firstFork, { firstFork, resumedFromRun1: report.resumedFromRun1 });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("request", (request) => {
    if (request.method() !== "GET") report.writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.addInitScript((id) => localStorage.setItem("yuzuno.selected", JSON.stringify(id)), source.id);
  const conflict = page.getByText("Another Codex client still owns this session", { exact: false });

  if (linkedAtStart) {
    // Closed still exists: the source keeps pointing there.
    await api(`/agents/${firstFork}/close`, "POST");
    report.apiWrites.push(`POST /agents/${firstFork}/close`);
    await page.goto(`${base}/?shell=desktop`);
    const notice = page.locator(".codex-writer-notice");
    await notice.getByText("(closed), from a Codex fork of its first 2 turns", { exact: false }).waitFor();
    check("a closed fork is still shown as the continuation", (await notice.getByRole("button", { name: "Continue in a fork…" }).count()) === 0,
      { notice: await notice.innerText() });
    await page.screenshot({ path: path.join(shots, "r2-1-closed.png") });

    // Deleted: the link goes and the conflict, with its explicit fork, is back.
    await api(`/agents/${firstFork}`, "DELETE");
    report.apiWrites.push(`DELETE /agents/${firstFork}`);
    report.liveUpdate = await conflict.waitFor({ timeout: 8000 }).then(() => true, () => false);
    if (!report.liveUpdate) {
      await page.reload();
      await conflict.waitFor();
    }
  } else {
    await page.goto(`${base}/?shell=desktop`);
    await conflict.waitFor();
  }
  const linkAfterDelete = (await api(`/agents/${source.id}`)).codexHandoff?.forkedTo ?? null;
  const deletedGone = !(await api("/workspace")).agents.some((a) => a.id === firstFork);
  check("deleting the fork frees the source", deletedGone && !linkAfterDelete
    && (await page.getByText("This conversation continues in", { exact: false }).count()) === 0, { linkAfterDelete, deletedGone });
  await page.screenshot({ path: path.join(shots, "r2-2-deleted.png") });

  await page.getByRole("button", { name: "Continue in a fork…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Copies 2 turns").waitFor();
  const text = await dialog.innerText();
  check("the dialog describes the history prefix truthfully",
    /History up to and including the latest completed turn, completed/.test(text) && !/completed turns/.test(text), { text });
  await page.screenshot({ path: path.join(shots, "r2-3-dialog.png") });
  const beforeCancel = [...report.writes];
  const agentsAtCancel = (await api("/workspace")).agents.length;
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached" });
  await page.waitForTimeout(1500);
  // Reading is held while the dialog is open; the read receipt for the
  // conversation on screen may follow. Anything else would be the dialog's.
  const duringCancel = report.writes.slice(beforeCancel.length);
  const readReceipt = `POST /api/agents/${source.id}/review`;
  const linkAfterCancel = (await api(`/agents/${source.id}`)).codexHandoff?.forkedTo ?? null;
  const agentsAfterCancel = (await api("/workspace")).agents.length;
  check("cancel writes nothing but the existing read receipt",
    duringCancel.every((w) => w === readReceipt) && forkPosts().length === 0 && !linkAfterCancel && agentsAfterCancel === agentsAtCancel,
    { beforeCancel, duringCancel, linkAfterCancel, agentsAtCancel, agentsAfterCancel });

  await page.getByRole("button", { name: "Continue in a fork…" }).click();
  await dialog.getByText("Copies 2 turns").waitFor();
  await dialog.getByRole("button", { name: "Fork and continue" }).click();
  await dialog.waitFor({ state: "detached", timeout: 180000 });
  const linked = (await api(`/agents/${source.id}`)).codexHandoff?.forkedTo;
  check("one explicit fork recovers a new continuation", forkPosts().length === 1 && !!linked && linked.agentId !== firstFork,
    { writes: [...report.writes], linked });
  await page.waitForFunction((id) => JSON.parse(localStorage.getItem("yuzuno.selected") || "null") === id, linked.agentId);
  check("nothing was sent", !report.writes.some((w) => /\/(messages|turns)$/.test(w)), { writes: [...report.writes] });
  await page.screenshot({ path: path.join(shots, "r2-4-forked.png") });

  const agentsAfter = (await api("/workspace")).agents;
  const added = agentsAfter.filter((a) => !agentsBefore.some((b) => b.id === a.id)).map((a) => a.id);
  check("no duplicate agent: the deleted fork is gone and exactly one new one exists",
    !agentsAfter.some((a) => a.id === firstFork) && added.length === 1 && added[0] === linked.agentId,
    { before: agentsBefore.length, after: agentsAfter.length, added });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error?.message || error);
} finally {
  await browser.close();
  await writeFile(path.join(lab, "browser-r2-report.json"), JSON.stringify(report, null, 2));
  console.log(`${report.status}: ${report.checks.length} checks; writes ${JSON.stringify(report.writes)}${report.error ? `; ${report.error}` : ""}`);
}
