// Requires an isolated real Core started by release-download-acceptance.py.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const origin = process.env.YUZUNO_RELEASE_URL;
const from = process.env.YUZUNO_RELEASE_FROM;
const to = process.env.YUZUNO_RELEASE_TO;
const output = process.env.YUZUNO_BROWSER_OUTPUT;
assert.ok(origin && from && to && output);
const url = new URL(origin);
assert.equal(url.hostname, '127.0.0.1');
assert.ok(Number(url.port) >= 4400 && Number(url.port) <= 4999);
await mkdir(output, { recursive: true });
const report = { mode: 'real-browser-real-Core', passed: false, checks: [], errors: [] };
const browser = await chromium.launch({
  executablePath: process.env.YUZUNO_BROWSER_BIN || '/usr/bin/chromium',
  headless: true, args: ['--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await context.addInitScript(() => {
  if (!localStorage.getItem('t13-seeded')) {
    localStorage.setItem('yuzuno.appearance', JSON.stringify({ theme: 'light', fontSize: 20, palette: 'garden' }));
    localStorage.setItem('t13-seeded', 'isolated browser state');
  }
});
const page = await context.newPage();
page.setDefaultTimeout(90000);
page.on('pageerror', error => report.errors.push(error.message));
const posts = [];
page.on('request', req => { if (req.method() === 'POST') posts.push(new URL(req.url()).pathname); });
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
async function get(path) { const response = await context.request.get(origin + path); assert.ok(response.ok()); return response.json(); }
async function screenshot(name) {
  const panel = page.getByRole('dialog');
  await panel.screenshot({ path: `${output}/${name}.png` });
  const size = await panel.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  assert.ok(size.scroll <= size.width + 1, `${name}: dialog has horizontal overflow`);
}
try {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Settings and updates' }).click();
  assert.equal((await get('/api/health')).releaseId, from);
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  // The signed release is offered as one choice; finding it starts nothing.
  await page.getByRole('button', { name: /^Update to / }).waitFor();
  assert.ok(!(await get('/api/updates')).operation);
  check('real signed release check does not prepare or apply');
  await screenshot('published-light-20px');
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await screenshot('published-dark-20px-760');
  // One click carries the release through every step; each is read from
  // the real Core while the chain runs, never assumed from an HTTP answer.
  const seen = new Set();
  const watch = setInterval(async () => {
    const current = await page.locator('[aria-label="Update progress"] [aria-current="step"]').innerText().catch(() => null);
    if (current) seen.add(current.trim());
  }, 100);
  const stepScreens = [];
  page.on('response', async response => {
    if (!response.url().endsWith('/api/updates') || stepScreens.length > 3) return;
    const phase = (await response.json().catch(() => null))?.releaseSource?.phase;
    if (['downloading', 'verifying'].includes(phase) && !stepScreens.includes(phase)) {
      stepScreens.push(phase);
      await screenshot(`step-${phase}`).catch(() => {});
    }
  });
  await page.getByRole('button', { name: `Update to ${(await get('/api/updates')).releaseSource.candidate.version}`, exact: true }).click();
  await page.getByRole('button', { name: 'Reload this window', exact: true }).waitFor({ timeout: 180000 });
  clearInterval(watch);
  report.stepsSeen = [...seen];
  assert.equal(posts.filter(p => p === '/api/updates/download').length, 1);
  assert.equal(posts.filter(p => p === '/api/updates/prepare').length, 1);
  check('one click downloads, verifies, prepares and applies on the real Core, one request each');
  assert.equal((await get('/api/updates')).operation.phase, 'complete');
  assert.equal((await get('/api/health')).releaseId, to);
  assert.equal(await page.locator('meta[name="yuzuno-release"]').getAttribute('content'), from);
  await screenshot('complete-old-window');
  check('real helper replacement completes while old browser stays open');
  await page.getByRole('button', { name: 'Reload this window', exact: true }).click();
  await page.waitForFunction(expected => document.querySelector('meta[name="yuzuno-release"]')?.content === expected, to);
  assert.equal(await page.evaluate(() => localStorage.getItem('t13-seeded')), 'isolated browser state');
  assert.equal(posts.filter(p => p === '/api/updates/apply').length, 1);
  assert.ok(!posts.some(p => /interrupt|reviewed/.test(p)));
  assert.deepEqual(report.errors, []);
  // No choice is left, for any Workspace (T-195 keeps them per Workspace).
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('yuzuno.update-intent'))), []);
  check('explicit reload loads matching UI and keeps browser storage; exactly one apply; the finished choice is forgotten');
  report.passed = true;
} finally {
  await browser.close();
  report.posts = posts;
  await writeFile(`${output}/receipt.json`, JSON.stringify(report, null, 2) + '\n');
}
