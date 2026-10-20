// Read-only browser acceptance against the owned lab. No native turn/import or
// daily request is allowed; only session preview and earlier-history reads.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const output = dirname(fileURLToPath(import.meta.url));
const root = resolve(output, '../..');
const base = 'http://127.0.0.1:4385';
const state = JSON.parse(await readFile(resolve(output, 'lab-check.json'), 'utf8'));
const { chromium } = await import(pathToFileURL(resolve(root, 'web/node_modules/playwright-core/index.mjs')));
const report = { checks: [], screenshots: [], errors: [], deniedWrites: [] };
await mkdir(resolve(output, 'screenshots'), { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/sbin/chromium', headless: true,
  args: ['--disable-dev-shm-usage'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ id }) => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    localStorage.setItem('yuzuno.selected', JSON.stringify(id));
    localStorage.setItem('yuzuno.appearance', JSON.stringify({ theme: 'light', fontSize: 20 }));
  }, { id: state.agentId });
  await context.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) return route.abort();
    if (['GET', 'HEAD'].includes(request.method()) ||
        (request.method() === 'POST' && url.pathname === '/api/codex/sessions/preview')) return route.continue();
    report.deniedWrites.push({ method: request.method(), path: url.pathname });
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', error => report.errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  async function memory(label) {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const values = Object.fromEntries(metrics.filter(m => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents'].includes(m.name)).map(m => [m.name, m.value]));
    report.checks.push({ label, ...values });
  }
  async function geometry(label) {
    const result = await page.evaluate(() => {
      const el = document.querySelector('[role=dialog]');
      const rect = el?.getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
        dialog: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null };
    });
    assert.ok(result.scrollWidth <= result.width + 2, label + ' page overflow');
    if (result.dialog) {
      assert.ok(result.dialog.left >= -1 && result.dialog.right <= result.width + 1, label + ' dialog width');
      assert.ok(result.dialog.top >= -1 && result.dialog.bottom <= result.height + 1, label + ' dialog height');
    }
    report.checks.push({ label, ...result });
    const path = resolve(output, 'screenshots', label + '.png');
    await page.screenshot({ path });
    report.screenshots.push(path);
  }
  async function openImport(id) {
    await page.getByRole('button', { name: 'Create agent', exact: true }).click();
    await page.getByRole('button', { name: 'Existing Codex session', exact: true }).click();
    await page.getByLabel('Codex session ID', { exact: true }).fill(id);
    await page.getByRole('button', { name: /Read|Preview/ }).click();
    await page.getByRole('dialog').getByText(state.model, { exact: false }).first().waitFor();
    await page.getByLabel('Permissions', { exact: true }).waitFor();
  }
  await page.goto(base + '/?shell=desktop');
  await page.getByRole('heading', { name: 'Integration · saved conversation', exact: true }).waitFor();
  const count = () => page.locator('.conversation-inner [data-turn-id]').count();
  let firstCount = await count();
  for (let i = 0; i < 100 && !firstCount; i++) {
    await page.waitForTimeout(100);
    firstCount = await count();
  }
  assert.ok(firstCount > 0 && firstCount < 10, 'Initial history should be bounded');
  await page.getByRole('navigation', { name: 'Loaded conversation turns', exact: true }).waitFor();
  report.checks.push({label:'Turn dock identifies imported pages as loaded turns'});
  await memory('recent-history');
  const earlier = page.getByRole('button', { name: 'Load earlier turns', exact: true });
  await earlier.scrollIntoViewIfNeeded();
  await earlier.click();
  await page.waitForFunction(n => document.querySelectorAll('.conversation-inner [data-turn-id]').length > n, firstCount);
  const loaded = await count();
  assert.ok(loaded > firstCount && loaded <= firstCount + 3);
  await page.waitForTimeout(5500); // one workspace refresh must retain expanded history
  assert.equal(await count(), loaded);
  const turnIds = await page.locator('.conversation-inner [data-turn-id]').evaluateAll(nodes => nodes.map(n => n.dataset.turnId));
  assert.equal(new Set(turnIds).size, turnIds.length);
  report.checks.push({ label: 'earlier turns remain after refresh without duplicates', firstCount, loaded });
  await memory('one-earlier-page');
  await geometry('history-light-20px');
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') {
      await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
      await page.locator('input[name="appearance-theme"][value="dark"]').check();
      await page.keyboard.press('Escape');
    }
    await openImport(state.sourceId);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await geometry(`import-${theme}-${width}-20px`);
    }
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.deniedWrites, []);
} finally {
  await browser.close();
  await writeFile(resolve(output, 'browser-live.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
