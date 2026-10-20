#!/usr/bin/env node
// T-27: the "Existing Claude session" dialog in a real browser on a lab
// Core (Chromium):
//
//   node browser.mjs <lab Core URL> <lab folder> <session N> <session S> <Project name> <screenshot folder>
//
// Lists the lab folder's sessions (scripted ones included: the lab's are
// `claude -p` sessions), chooses N with the keyboard, confirms its name,
// Project and folder, and adds it; then, dark and 390 px wide, shows S as
// already imported. The dialog's first, unfiltered page would list the
// user's own sessions: this script answers it with an empty page, so no
// screenshot or output holds anything but the lab's sessions. Prints one
// JSON line of what the page showed; live.py judges it.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const [base, folder, sessionN, sessionS, projectName, shots] = process.argv.slice(2);
if (!shots) {
  console.error('usage: node browser.mjs <lab Core URL> <lab folder> <session N> <session S> <Project name> <screenshot folder>');
  process.exit(2);
}
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || '/usr/sbin/chromium' });
const out = {};

async function dialog(context, theme) {
  const page = await context.newPage();
  // The app's own appearance setting (light unless chosen).
  await page.addInitScript((value) => localStorage.setItem('yuzuno.appearance', JSON.stringify({ theme: value })), theme);
  await page.route('**/api/claude/sessions?*', (route) => (new URL(route.request().url()).searchParams.get('dir')
    ? route.continue()
    : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [], offset: 0, next: null }) })));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const add = page.locator('button.add-agent');
  await add.waitFor({ state: 'attached', timeout: 30000 });
  // Narrow screens keep the rail closed: the shortcut opens the same dialog.
  if (await add.isVisible()) await add.click();
  else await page.keyboard.press('Control+n');
  await page.getByRole('button', { name: 'Existing Claude session', exact: true }).click();
  await page.locator('.claude-sessions-filter input').check();
  await page.getByLabel('Only sessions in this folder').fill(folder);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.locator('.claude-session-list button').first().waitFor({ timeout: 30000 });
  return page;
}
const row = (page, id) => page.locator(`.claude-session-list button[data-session="${id}"]`);

try {
  const light = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
  const page = await dialog(light, 'light');
  out.filterRow = await page.locator('.claude-sessions-filter').evaluate((label) => {
    const box = label.querySelector('input').getBoundingClientRect();
    const text = label.getBoundingClientRect();
    return { direction: getComputedStyle(label).flexDirection, checkboxWidth: Math.round(box.width), sameLine: box.bottom > text.top && box.top < text.bottom && box.left - text.left < 4 };
  });
  out.listed = await page.locator('.claude-session-list button').evaluateAll((nodes) => nodes.map((n) => ({
    session: n.dataset.session, title: n.querySelector('strong')?.textContent, imported: Boolean(n.querySelector('.claude-session-badge')),
  })));
  await page.screenshot({ path: join(shots, 'list-light.png') });
  // Keyboard: focus N's row and choose it with Enter.
  await row(page, sessionN).focus();
  await page.keyboard.press('Enter');
  await page.locator('.session-preview').waitFor({ timeout: 60000 });
  out.keyboardChose = await page.locator('.claude-session-list button[aria-pressed="true"]').getAttribute('data-session');
  await page.getByLabel('Project', { exact: true }).selectOption({ label: projectName });
  const name = page.getByLabel('Agent name');
  await name.fill('T27 browser import');
  out.preview = {
    heading: (await page.locator('.session-preview-heading span').first().textContent()).trim(),
    prompts: (await page.locator('.session-preview-heading span').last().textContent()).trim(),
    recent: await page.locator('.claude-session-recent li > span').allTextContents(),
    folder: await page.getByLabel('Folder', { exact: true }).inputValue(),
    project: await page.getByLabel('Project', { exact: true }).evaluate((n) => n.selectedOptions[0].textContent),
    handoff: await page.locator('.session-handoff-note').textContent(),
  };
  await page.screenshot({ path: join(shots, 'preview-light.png'), fullPage: true });
  await page.getByRole('button', { name: 'Add to workspace', exact: true }).click();
  await page.locator('[role="dialog"]').waitFor({ state: 'detached', timeout: 60000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(shots, 'imported-light.png') });
  await light.close();

  const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  const narrow = await dialog(dark, 'dark');
  await row(narrow, sessionS).click();
  await narrow.locator('.session-preview').waitFor({ timeout: 60000 });
  out.existing = {
    theme: await narrow.evaluate(() => document.documentElement.dataset.theme),
    heading: (await narrow.locator('.session-preview-heading span').first().textContent()).trim(),
    action: (await narrow.locator('.modal-actions .primary-button').textContent()).trim(),
    overflow: await narrow.evaluate(() => {
      const box = document.querySelector('[role="dialog"]')?.getBoundingClientRect();
      return document.documentElement.scrollWidth > window.innerWidth || !box || box.left < 0 || box.right > window.innerWidth;
    }),
  };
  await narrow.screenshot({ path: join(shots, 'existing-dark-narrow.png'), fullPage: true });
  await dark.close();
} finally {
  await browser.close();
}
console.log(JSON.stringify(out));
