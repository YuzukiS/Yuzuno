// Daily deployment smoke: independent headless browser, GET/HEAD only.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const output = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(pathToFileURL(resolve(output, '../../web/node_modules/playwright-core/index.mjs')));
const base = 'http://127.0.0.1:4317';
const id = '472db31d-3e33-4d2e-a0d3-01a413d96e4e';
const report = { startedAt: new Date().toISOString(), base, agentId: id, checks: [], browserErrors: [], httpErrors: [], blockedMutations: [], scope: 'Independent headless Chromium. document.hasFocus is forced false and all non-GET/HEAD requests are aborted. User windows and daily data are not manipulated.' };
const getDetail = async () => {
  const response = await fetch(`${base}/api/agents/${id}`);
  assert.ok(response.ok);
  return response.json();
};
const before = await getDetail();
const browser = await chromium.launch({ headless: true, executablePath: '/usr/sbin/chromium' });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ id }) => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    localStorage.setItem('yuzuno.selected', JSON.stringify(id));
    localStorage.setItem('yuzuno.appearance', JSON.stringify({ theme: 'light', fontSize: 20 }));
  }, { id });
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) {
      report.blockedMutations.push({ method: request.method(), path: url.pathname });
      return route.abort();
    }
    if (url.origin !== base) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) report.httpErrors.push({ status: response.status(), path: new URL(response.url()).pathname }); });
  await page.goto(`${base}/?shell=desktop`);
  await page.getByRole('heading', { name: 'Dev 1', exact: true }).waitFor();
  const row = page.locator(`.agent-row[data-agent-id="${id}"]`);
  await row.locator('.agent-work-summary').waitFor();
  assert.equal(await row.getByRole('button', { name: 'Open Dev 1', exact: true }).getAttribute('aria-current'), 'true');
  const summary = before.agent.workSummary;
  assert.ok(summary?.text);
  assert.equal(await row.locator('.agent-work-summary').getAttribute('data-source-kind'), summary.kind);
  assert.ok((await row.locator('.agent-work-summary').innerText()).includes(summary.text));
  await page.screenshot({ path: resolve(output, 'daily-ui.png'), fullPage: true });
  report.checks.push({ name: 'new-rail-and-existing-dev1-displayed', kind: summary.kind, source: summary.source });

  await row.locator('.agent-work-summary').click();
  const highlighted = page.locator('.source-highlight').first();
  await highlighted.waitFor();
  const source = await highlighted.evaluate(element => ({ id: element.id, itemId: element.getAttribute('data-item-id'), turnId: element.closest('[data-turn-id]')?.getAttribute('data-turn-id') || null }));
  if (summary.itemId) assert.ok(source.itemId === summary.itemId || source.id === `item-${summary.itemId}`, `Wrong highlighted item ${JSON.stringify(source)}`);
  await page.screenshot({ path: resolve(output, 'daily-source-link.png'), fullPage: true });
  report.checks.push({ name: 'rail-summary-navigates-to-original-source', expectedItemId: summary.itemId, expectedTurnId: summary.turnId, actual: source });

  assert.equal(await page.getByRole('button', { name: 'Agent settings', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.waitFor();
  for (const label of ['Model', 'Reasoning effort', 'Access', 'Approval requests']) assert.equal(await dialog.getByLabel(label, { exact: true }).count(), 1, label);
  report.checks.push({ name: 'model-reasoning-access-approval-settings-present' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });

  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(await dialog.getByLabel(/lasting purpose|用途备注|purpose/i).count(), 0);
  await dialog.getByLabel('Name', { exact: true }).fill('Read-only smoke: never submitted');
  await dialog.getByLabel(/^Working folder/).fill((process.env.HOME + '/yuzuno-next'));
  assert.equal(await dialog.getByRole('button', { name: 'Create agent', exact: true }).isEnabled(), true);
  await page.screenshot({ path: resolve(output, 'daily-create-dialog.png'), fullPage: true });
  report.checks.push({ name: 'creation-has-no-purpose-and-name-folder-suffice-without-submission' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1600);
  assert.equal(await page.evaluate(() => document.hasFocus()), false);
  const after = await getDetail();
  assert.equal(after.agent.id, before.agent.id);
  assert.equal(after.agent.threadId, before.agent.threadId);
  assert.equal(after.agent.reviewedSeq, before.agent.reviewedSeq);
  assert.equal(report.blockedMutations.length, 0);
  assert.equal(report.browserErrors.length, 0);
  assert.equal(report.httpErrors.length, 0);
  report.checks.push({ name: 'no-write-attempts-no-javascript-errors-no-http-errors', reviewedSeqUnchanged: true, nativeThreadUnchanged: true });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack || String(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'browser-smoke-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
