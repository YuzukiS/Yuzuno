// Exact existing-Agent controls only. The runtime runner prepares the native
// request/Turn and explicitly signals readiness; this helper sends no model task.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const lab = dirname(fileURLToPath(import.meta.url));
const root = resolve(lab, "../..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "request-id": { type: "string" }, "turn-id": { type: "string" } },
});
const action = positionals[0];
assert.ok(["approve", "interrupt"].includes(action), "Use approve --request-id ID or interrupt --turn-id ID after the runtime runner signals ready.");
const base = "http://127.0.0.1:4327";
const agentId = "3fca0686-0f2f-4573-a342-bc5db1783b55";
const marker = "YUZUNO_REMOTE_APPROVAL_OK";
const cwd = JSON.parse(await readFile(resolve(lab, "mac-paths.json"), "utf8")).cwd;
const id = action === "approve" ? values["request-id"] : values["turn-id"];
assert.ok(id && /^[a-zA-Z0-9_-]+$/.test(id), "The exact expected native request/Turn ID is required.");
const processRecord = JSON.parse(await readFile(resolve(lab, "core-process.json"), "utf8"));
assert.equal(processRecord.baseUrl, base);
assert.equal(processRecord.dataDir, resolve(lab, "core-data"));
const stat = await readFile(`/proc/${processRecord.pid}/stat`, "utf8");
assert.equal(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19], processRecord.startTicks);
const argv = (await readFile(`/proc/${processRecord.pid}/cmdline`, "utf8")).replace(/\0$/, "").split("\0");
assert.deepEqual(argv, processRecord.argv);
assert.ok(argv.includes(resolve(lab, "core-data")) && argv.includes("4327"));

const report = {
  action, expectedId: id, agentId, startedAt: new Date().toISOString(),
  checks: [], browserErrors: [], blockedRequests: [], submitted: [],
};
const record = (check, details = {}) => report.checks.push({ check, ...details });
const delay = ms => new Promise(done => setTimeout(done, ms));
async function detail() {
  const response = await fetch(`${base}/api/agents/${agentId}`);
  assert.equal(response.ok, true);
  const body = await response.json();
  assert.equal(body.agent.id, agentId);
  assert.equal(body.agent.cwd, cwd);
  assert.equal(body.agent.remote?.machine?.target, (process.env.YUZUNO_SSH_TARGET || "tester@192.0.2.10"));
  return body;
}
function exactCommand(command, expected) {
  if (command === expected) return true;
  for (const shell of ["/bin/zsh", "/bin/bash", "/bin/sh"])
    for (const flag of ["-lc", "-c"])
      for (const quote of ["'", '"'])
        if (command === `${shell} ${flag} ${quote}${expected}${quote}`) return true;
  return false;
}
function checkPending(current) {
  const pending = current.pending.find(request => request.id === id);
  assert.ok(pending, "The exact expected request is no longer pending.");
  assert.equal(pending.method, "item/commandExecution/requestApproval");
  assert.equal(pending.stale, false);
  assert.notEqual(pending.params._responseSent, true);
  assert.equal(pending.params.cwd, cwd);
  assert.ok(exactCommand(pending.params.command, `printf ${marker}`), "Unexpected approval command; no approval will be sent.");
  assert.ok(!pending.params.availableDecisions || pending.params.availableDecisions.includes("accept"));
  return pending;
}
function checkTurn(current) {
  const turn = current.turns.find(turn => turn.id === id);
  assert.ok(turn && turn.status === "inProgress", "The exact expected Turn is not running.");
  assert.ok(turn.items.some(item => item.type === "commandExecution" && exactCommand(item.command, "/bin/sleep 45")),
    "Expected the fixed bounded sleep command; refusing to interrupt a different task.");
  return turn;
}

let browser;
let page;
try {
  const before = await detail();
  const pending = action === "approve" ? checkPending(before) : null;
  if (action === "interrupt") checkTurn(before);
  const turnId = pending ? pending.params.turnId : id;
  report.turnId = turnId;
  report.threadId = before.agent.threadId;
  report.runtimeInstance = before.agent.remote.runtime.instanceId;
  if (pending) record("exact-live-request-preflight", { command: pending.params.command, cwd });
  else record("exact-bounded-running-turn-preflight", { turnId });

  const { chromium } = await import(pathToFileURL(resolve(root, "web/node_modules/playwright-core/index.mjs")));
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.YUZUNO_BROWSER_BIN || (process.env.HOME + '/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome'),
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const mutation = action === "approve" ? `/api/requests/${id}/respond` : `/api/agents/${agentId}/interrupt`;
  const expectedBody = action === "approve" ? { response: { decision: "accept" } } : {};
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (["data:", "blob:", "about:"].includes(url.protocol)) return route.continue();
    let allowed = url.origin === base && ["GET", "HEAD"].includes(request.method());
    if (url.origin === base && url.pathname === mutation && request.method() === "POST" && report.submitted.length === 0) {
      try {
        assert.deepEqual(request.postDataJSON(), expectedBody);
        report.submitted.push({ url: request.url(), body: request.postDataJSON() });
        allowed = true;
      } catch { /* Any unexpected body stays blocked. */ }
    }
    if (allowed) return route.continue();
    report.blockedRequests.push({ url: request.url(), method: request.method() });
    return route.abort("blockedbyclient");
  });
  page = await context.newPage();
  page.on("pageerror", error => report.browserErrors.push(error.message));
  await page.goto(`${base}/?shell=desktop`);
  await page.locator(".agent-row").filter({ has: page.locator(".agent-name", { hasText: before.agent.name }) }).click();
  await page.getByRole("heading", { name: before.agent.name, exact: true }).waitFor();
  if (action === "approve") {
    const card = page.locator(`[id="request-${id}"]`);
    await card.getByRole("button", { name: "Allow once", exact: true }).waitFor();
    assert.ok((await card.innerText()).includes(marker));
    checkPending(await detail());
    await page.screenshot({ path: resolve(lab, "gui-approval-before.png"), animations: "disabled" });
    await card.getByRole("button", { name: "Allow once", exact: true }).click();
  } else {
    checkTurn(await detail());
    await page.locator(`[data-turn-id="${turnId}"] .turn-activity`).getByText("Working", { exact: true }).waitFor();
    await page.screenshot({ path: resolve(lab, "gui-interrupt-before.png"), animations: "disabled" });
    await page.getByRole("button", { name: /^Interrupt/ }).click();
  }
  record("one-real-gui-control-clicked", { mutation });
  const until = Date.now() + 120_000;
  let after;
  let turn;
  while (Date.now() < until) {
    after = await detail();
    turn = after.turns.find(turn => turn.id === turnId);
    if (turn && ["completed", "interrupted", "failed"].includes(turn.status)) break;
    await delay(300);
  }
  assert.equal(turn?.status, action === "approve" ? "completed" : "interrupted");
  assert.equal(after.agent.threadId, before.agent.threadId);
  assert.equal(after.agent.remote.runtime.instanceId, before.agent.remote.runtime.instanceId);
  assert.equal(after.agent.reviewedSeq, before.agent.reviewedSeq);
  if (action === "approve") {
    assert.ok(turn.items.some(item => item.type === "commandExecution" && item.exitCode === 0 && item.aggregatedOutput?.includes(marker)));
    assert.ok(!after.pending.some(request => request.id === id));
    record("native-fixed-print-finished-after-one-approval");
  } else record("native-turn-interrupted-with-session-preserved");
  await page.locator(`[data-turn-id="${turnId}"] .turn-activity`).waitFor({ state: "detached" });
  await page.screenshot({ path: resolve(lab, `gui-${action}-after.png`), animations: "disabled" });
  assert.equal(report.submitted.length, 1);
  assert.deepEqual(report.blockedRequests, []);
  assert.deepEqual(report.browserErrors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack || String(error);
  await page?.screenshot({ path: resolve(lab, `gui-${action}-failure.png`), animations: "disabled" }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(lab, `gui-${action}-report.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
