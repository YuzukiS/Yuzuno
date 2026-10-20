import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../../web/node_modules/playwright-core/index.mjs';

const base = 'http://127.0.0.1:4318';
const id = (await readFile(new URL('./agent-id', import.meta.url), 'utf8')).trim();
const browser = await chromium.launch({ executablePath: (process.env.HOME + '/.cache/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux64/chrome-headless-shell') });
const page = await browser.newPage({ viewport: { width: 1320, height: 900 } });
const report = { startedAt: new Date().toISOString(), agentId: id, checks: [] };
const read = async () => (await page.request.get(`${base}/api/agents/${id}`)).json();
try {
  const before = await read();
  const pending = before.pending.find(p => p.method === 'item/commandExecution/requestApproval');
  assert.ok(pending, 'Requires a genuine native request already inspected by the operator');
  assert.equal(pending.params.cwd, (process.env.HOME + '/yuzuno-next/acceptance/controls/task'));
  assert.deepEqual(pending.params.commandActions, [{ command: `python -c "print('YUZUNO_APPROVAL_ACCEPTANCE')"`, type: 'unknown' }]);
  await page.goto(`${base}/?shell=desktop`);
  await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Decline', exact: true }).isDisabled(), true);
  await page.reload();
  await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
  assert.equal((await read()).pending[0].id, pending.id);
  report.checks.push('native approval survives GUI reload without duplicate request');
  await page.screenshot({ path: 'acceptance/controls/evidence/approval.png', animations: 'disabled', mask: [page.locator('.runtime-account')] });
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  const deadline = Date.now() + 120_000;
  let done;
  while (Date.now() < deadline) {
    const detail = await read();
    const turn = detail.turns.find(t => t.id === pending.params.turnId);
    if (turn?.status === 'completed' && detail.pending.length === 0) { done = detail; break; }
    await new Promise(r => setTimeout(r, 500));
  }
  assert.ok(done, 'Native completion and request resolution not observed');
  const turn = done.turns.find(t => t.id === pending.params.turnId);
  const command = turn.items.find(i => i.id === pending.params.itemId);
  assert.equal(command.exitCode, 0);
  assert.match(command.aggregatedOutput, /YUZUNO_APPROVAL_ACCEPTANCE/);
  report.checks.push('GUI Allow once reaches native harness and exact harmless command exits 0');
  report.checks.push('native resolution clears Pending');
  report.requestId = pending.id;
  report.threadId = done.agent.threadId;
  report.turnId = turn.id;
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; process.exitCode = 1;
} finally {
  await writeFile('acceptance/controls/approval-report.json', JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify(report));
