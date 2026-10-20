#!/usr/bin/env node
// T-29: the composer's slash list in a real browser on a lab Core, with real
// key presses (Chromium):
//
//   node browser.mjs <lab Core URL> <Agent id> <screenshot folder>
//
// Opens the Agent, types "/" at the start of an empty draft, reads the list,
// narrows it to "/cont", moves with the arrows, fills in the chosen command
// with Enter (nothing is sent), adds an argument-free send with a second
// Enter, and types a slash after other text, which must open nothing. Prints
// one JSON line of what the page showed; live.py judges it.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const [base, agent, shots] = process.argv.slice(2);
if (!base || !agent || !shots) {
  console.error('usage: node browser.mjs <lab Core URL> <Agent id> <screenshot folder>');
  process.exit(2);
}
mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || '/usr/sbin/chromium' });
const out = {};
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.addInitScript((id) => localStorage.setItem('yuzuno.selected', JSON.stringify(id)), agent);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('.cm-content[data-composer-input]');
  await composer.waitFor({ timeout: 30000 });
  await composer.click();
  const options = () => page.locator('.slash-menu [role=option]').evaluateAll((nodes) => nodes.map((n) => ({
    name: n.querySelector('.slash-menu-name')?.textContent,
    source: n.querySelector('.slash-menu-source')?.textContent,
    selected: n.getAttribute('aria-selected') === 'true',
  })));
  const text = () => composer.evaluate((node) => node.textContent);
  await page.keyboard.type('/');
  await page.locator('.slash-menu [role=option]').first().waitFor({ timeout: 60000 });
  const all = await options();
  out.opened = { count: all.length, names: all.map((o) => o.name), sources: [...new Set(all.map((o) => o.source))] };
  out.note = await page.locator('.slash-menu-note.is-source').textContent();
  const box = await page.locator('.slash-menu').boundingBox();
  const field = await page.locator('.composer').first().boundingBox();
  out.placement = { menuBottom: box && Math.round(box.y + box.height), composerTop: field && Math.round(field.y), menuTop: box && Math.round(box.y) };
  await page.screenshot({ path: join(shots, 'slash-open.png') });
  await page.keyboard.type('cont');
  await page.waitForFunction(() => [...document.querySelectorAll('.slash-menu [role=option] .slash-menu-name')].every((n) => n.textContent.includes('cont')));
  out.narrowed = await options();
  await page.keyboard.press('ArrowDown');
  out.afterDown = (await options()).map((o) => o.selected);
  await page.keyboard.press('ArrowUp');
  const chosen = (await options()).find((o) => o.selected)?.name;
  out.chosen = chosen;
  await page.screenshot({ path: join(shots, 'slash-narrowed.png') });
  await page.keyboard.press('Enter');
  out.filled = await text();
  out.menuAfterFill = await page.locator('.slash-menu').count();
  // Back to the bare name "/context": Enter sends it as typed.
  await page.keyboard.press('End');
  await page.keyboard.type('x');
  for (let i = 0; i < 2; i++) await page.keyboard.press('Backspace');
  out.beforeSend = await text();
  await page.keyboard.press('Enter');
  // Sent: the draft is empty again and shows its placeholder.
  await page.waitForFunction(() => !!document.querySelector('.cm-content[data-composer-input] .cm-placeholder'), null, { timeout: 30000 });
  out.sent = true;
  // A slash after other text opens nothing.
  await composer.click();
  await page.keyboard.type('see /usr/bin and /co');
  await page.waitForTimeout(800);
  out.midText = { menu: await page.locator('.slash-menu').count(), text: await text() };
  await page.screenshot({ path: join(shots, 'slash-mid-text.png') });
  for (let i = 0; i < 'see /usr/bin and /co'.length; i++) await page.keyboard.press('Backspace');
} finally {
  await browser.close();
}
console.log(JSON.stringify(out));
