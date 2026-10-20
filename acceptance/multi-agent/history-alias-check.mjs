// Read-only verification of real recovered history, source links, and crash UI.
// Never sends a model task, reconnect, review, approval, or interrupt request.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const lab = dirname(fileURLToPath(import.meta.url));
const root = resolve(lab, "../..");
const base = "http://127.0.0.1:4327";
const remoteId = "3fca0686-0f2f-4573-a342-bc5db1783b55";
const jsonFile = async name => JSON.parse(await readFile(resolve(lab, name), "utf8"));
const ownership = await jsonFile("core-process.json");
assert.equal(ownership.baseUrl, base);
assert.equal(ownership.dataDir, resolve(lab, "core-data"));
const stat = await readFile(`/proc/${ownership.pid}/stat`, "utf8");
assert.equal(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19], ownership.startTicks);
assert.deepEqual((await readFile(`/proc/${ownership.pid}/cmdline`, "utf8")).replace(/\0$/, "").split("\0"), ownership.argv);
const report = { startedAt: new Date().toISOString(), baseUrl: base, corePid: ownership.pid,
  checks: [], browserErrors: [], blockedRequests: [] };
const record = (check, details = {}) => report.checks.push({ check, ...details });
async function api(path) {
  assert.ok(path.startsWith("/api/"));
  const response = await fetch(`${base}${path}`);
  assert.equal(response.ok, true, `${path}: ${response.status}`);
  return response.json();
}
let browser;
let page;
try {
  const before = await api("/api/workspace");
  const baseline = await jsonFile("recovery-baseline.json");
  const details = await Promise.all(before.agents.map(agent => api(`/api/agents/${agent.id}`)));
  assert.equal(details.length, 3);
  for (const saved of baseline.identities) {
    const current = details.find(detail => detail.agent.id === saved.id);
    assert.ok(current);
    for (const key of ["name", "goal", "cwd", "threadId"]) assert.equal(current.agent[key], saved[key]);
    for (const oldTurn of saved.turns) {
      const turn = current.turns.find(turn => turn.id === oldTurn.id);
      assert.ok(turn, `Original Turn ${oldTurn.id} is missing.`);
      for (const oldItem of oldTurn.items)
        assert.ok(turn.items.some(item => item.id === oldItem.id && item.type === oldItem.type), `Original source item ${oldItem.id} is missing.`);
    }
  }
  record("all-three-agents-original-native-threads-turns-and-source-ids-retained", { agentIds: details.map(detail => detail.agent.id) });

  const remote = details.find(detail => detail.agent.id === remoteId);
  assert.ok(remote);
  const observation = await jsonFile("history-alias-observation.json");
  const turn = remote.turns.find(turn => turn.id === observation.turn.id);
  assert.ok(turn);
  const originalUser = observation.turn.items.find(item => item.type === "userMessage" && !/^item-\d+$/.test(item.id));
  const originalComment = observation.turn.items.find(item => item.type === "agentMessage" && item.phase === "commentary" && !/^item-\d+$/.test(item.id));
  assert.ok(originalUser && originalComment);
  assert.deepEqual(turn.items.filter(item => item.type === "userMessage").map(item => item.id), [originalUser.id]);
  const comments = turn.items.filter(item => item.type === "agentMessage" && item.phase === "commentary" && item.text === originalComment.text);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, originalComment.id);
  assert.equal(new Set(turn.items.map(item => item.id)).size, turn.items.length);
  record("replayed-message-aliases-collapse-to-original-live-ids", {
    turnId: turn.id, userItemId: originalUser.id, commentaryItemId: originalComment.id,
    userMessages: 1, matchingCommentaries: 1,
  });

  const { chromium } = await import(pathToFileURL(resolve(root, "web/node_modules/playwright-core/index.mjs")));
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.YUZUNO_BROWSER_BIN || (process.env.HOME + '/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome') });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (["data:", "blob:", "about:"].includes(url.protocol)) return route.continue();
    if (url.origin === base && ["GET", "HEAD"].includes(request.method())) return route.continue();
    report.blockedRequests.push({ method: request.method(), url: request.url() });
    return route.abort("blockedbyclient");
  });
  page = await context.newPage();
  page.on("pageerror", error => report.browserErrors.push(error.message));
  await page.goto(`${base}/?shell=desktop`);
  await page.locator(".agent-row").filter({ has: page.locator(".agent-name", { hasText: remote.agent.name }) }).click();
  await page.getByRole("heading", { name: remote.agent.name, exact: true }).waitFor();
  const article = page.locator(`[data-turn-id="${turn.id}"]`);
  await article.waitFor();
  assert.equal(await article.locator(`[data-item-id="${originalUser.id}"]`).count(), 1);
  assert.equal(await article.locator(".commentary").filter({ hasText: originalComment.text }).count(), 1);

  await page.getByRole("button", { name: "Search conversation", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Search loaded messages", { exact: true }).fill(originalComment.text);
  const matches = page.locator(".conversation-search-result");
  await matches.first().waitFor();
  assert.equal(await matches.count(), 1, "Search should see one original commentary, not replay aliases.");
  await matches.click();
  const source = article.locator(`[data-item-id="${originalComment.id}"]`);
  await source.locator("xpath=self::*[@data-search-highlight='true']").waitFor();
  assert.equal(await source.evaluate(element => document.activeElement === element), true);
  await page.screenshot({ path: resolve(lab, "history-alias-search-source.png"), animations: "disabled" });
  record("gui-search-finds-one-message-and-jumps-to-original-live-source", { itemId: originalComment.id });

  const catchup = await api("/api/catchup");
  const citation = catchup.items.find(item => item.agentId === remoteId && item.turnId === turn.id && item.itemId);
  assert.ok(citation, "Expected the unread approval completion to retain a Catch-up source.");
  assert.ok(turn.items.some(item => item.id === citation.itemId));
  await page.locator(".catchup-nav").click();
  const entry = page.locator(".catchup-item").filter({ hasText: citation.body });
  await entry.waitFor();
  assert.equal(await entry.count(), 1);
  await entry.click();
  const cited = page.locator(`[data-turn-id="${citation.turnId}"] [data-item-id="${citation.itemId}"]`);
  await cited.locator("xpath=self::*[contains(@class,'source-highlight')]").waitFor();
  assert.equal(await cited.evaluate(element => document.activeElement === element), true);
  await page.getByRole("button", { name: "Back to catch up", exact: true }).waitFor();
  await page.screenshot({ path: resolve(lab, "history-alias-catchup-source.png"), animations: "disabled" });
  record("gui-catchup-opens-exact-original-reply-without-fallback", { turnId: citation.turnId, itemId: citation.itemId });

  const crashed = [...remote.turns].reverse().find(value => value.status === "interrupted" && value.items.some(item => item.type === "commandExecution" && item.status === "inProgress"));
  assert.ok(crashed, "Expected native hard-crash evidence with unconfirmed command status.");
  const crashView = page.locator(`[data-turn-id="${crashed.id}"]`);
  await crashView.scrollIntoViewIfNeeded();
  assert.equal(await crashView.locator(".turn-activity").count(), 0);
  assert.equal(await crashView.locator("details.execution > summary .spin").count(), 0);
  const command = crashed.items.find(item => item.type === "commandExecution" && item.status === "inProgress");
  const tool = crashView.locator(`[id="item-${command.id}"]`);
  const group = tool.locator("xpath=ancestor::details[contains(@class,'execution')]");
  if (!await group.evaluate(element => element.open)) await group.locator(":scope > summary").click();
  await tool.getByText("Unconfirmed", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(lab, "history-alias-unconfirmed-tool.png"), animations: "disabled" });
  record("interrupted-native-turn-keeps-unconfirmed-tool-evidence-without-working-spinner", {
    turnId: crashed.id, toolItemId: command.id, nativeToolStatus: command.status, nativeExitCode: command.exitCode,
  });

  const after = await api("/api/workspace");
  for (const agent of after.agents) {
    const previous = before.agents.find(value => value.id === agent.id);
    assert.ok(previous);
    for (const key of ["reviewedSeq", "unreadCount", "pendingCount"]) assert.equal(agent[key], previous[key]);
  }
  assert.deepEqual(report.blockedRequests, []);
  assert.deepEqual(report.browserErrors, []);
  record("all-browsing-and-source-jumps-readonly-unread-pending-review-state-unchanged");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack || String(error);
  await page?.screenshot({ path: resolve(lab, "history-alias-recovery-failure.png"), animations: "disabled" }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(lab, "history-alias-recovery.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
