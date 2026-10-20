#!/usr/bin/env node
// T-94: the usage-limit notice and the "Usage limit" row in a real browser
// on a lab Core (Chromium):
//
//   node browser.mjs <lab Core URL> <Agent id> <screenshot folder>
//
// The Agent's latest turn was stopped by the limit and automatic continue
// waits. Reads the notice and the row, screenshots them light and wide,
// then dark and 390 px wide, and finally chooses "Don't continue
// automatically". Prints one JSON line of what the page showed; live.py
// judges it.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const [base, agent, shots] = process.argv.slice(2);
if (!shots) {
  console.error('usage: node browser.mjs <lab Core URL> <Agent id> <screenshot folder>');
  process.exit(2);
}
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || '/usr/sbin/chromium' });
const out = {};

async function open(context, theme) {
  const page = await context.newPage();
  await page.addInitScript(([id, value]) => {
    localStorage.setItem('yuzuno.selected', JSON.stringify(id));
    localStorage.setItem('yuzuno.appearance', JSON.stringify({ theme: value }));
  }, [agent, theme]);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.quota-resume-notice').waitFor({ timeout: 30000 });
  return page;
}

try {
  const light = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: 'light' });
  const page = await open(light, 'light');
  const notice = page.locator('.quota-resume-notice');
  out.waiting = {
    text: (await notice.locator('span').first().textContent()).trim(),
    buttons: await notice.locator('button').allTextContents(),
  };
  const setting = page.getByLabel('After Claude’s usage limit resets');
  out.setting = { value: await setting.inputValue(), options: await setting.locator('option').allTextContents(),
    // The chosen option's text fits the box (a select cuts what does not).
    fits: await setting.evaluate((n) => {
      const probe = document.createElement('span');
      probe.textContent = n.selectedOptions[0].textContent;
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(n).font}`;
      document.body.append(probe);
      const fits = probe.getBoundingClientRect().width + 28 <= n.getBoundingClientRect().width;
      probe.remove();
      return fits;
    }) };
  await page.screenshot({ path: join(shots, 'waiting-light.png') });
  await light.close();

  const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  const narrow = await open(dark, 'dark');
  const box = await narrow.locator('.quota-resume-notice').boundingBox();
  out.narrow = {
    theme: await narrow.evaluate(() => document.documentElement.dataset.theme),
    overflow: await narrow.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    fits: Boolean(box && box.x >= 0 && box.x + box.width <= 390),
  };
  await narrow.screenshot({ path: join(shots, 'waiting-dark-narrow.png') });
  // Keyboard: reach "Don't continue automatically" and press it.
  const cancel = narrow.getByRole('button', { name: 'Don’t continue automatically', exact: true });
  await cancel.focus();
  await narrow.keyboard.press('Enter');
  await narrow.waitForFunction(() => document.querySelector('.quota-resume-notice span')?.textContent?.includes('cancelled'));
  out.cancelled = {
    text: (await narrow.locator('.quota-resume-notice span').first().textContent()).trim(),
    buttons: await narrow.locator('.quota-resume-notice button').allTextContents(),
  };
  await narrow.screenshot({ path: join(shots, 'cancelled-dark-narrow.png') });
  await dark.close();
} finally {
  await browser.close();
}
console.log(JSON.stringify(out));
