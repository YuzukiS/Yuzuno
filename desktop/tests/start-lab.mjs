// The window half of the T-171 start lab (desktop/tests/start-lab.py): one
// step in the real lab desktop window, through its test-only DevTools port.
// Prints one JSON line with what the window showed.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '../../web/node_modules/playwright-core/index.mjs';

const [step, endpoint, core, shots] = process.argv.slice(2);
const page_ = 'http://tauri.localhost/index.html';
const workspace = `${core}/?shell=desktop`;
await mkdir(shots, { recursive: true });
const browser = await chromium.connectOverCDP(endpoint);
const result = { step };
try {
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  const status = page.locator('#connection-message');
  const shot = (name) => page.screenshot({ path: resolve(shots, `${name}.png`) });
  const offerStart = async () => {
    await page.goto(page_);
    await page.locator('#connect-button').click();
    await page.getByText(/not reachable|Core returned HTTP|not a Yuzuno Core/).waitFor({ timeout: 30_000 });
    result.connectError = await status.textContent();
    result.startShown = await page.locator('#start-row').isVisible();
    result.startLabel = await page.locator('#start-button').textContent();
  };
  if (step === 'connected') {
    await page.waitForURL(workspace, { timeout: 60_000 });
    result.url = page.url();
    await shot('1-connected');
  } else if (step === 'start') {
    await offerStart();
    await shot('2-offline-start-offered');
    const clicked = Date.now();
    await page.locator('#start-button').click();
    result.duringStart = await status.textContent();
    result.disabledDuringStart = await page.locator('#start-button').isDisabled()
      && await page.locator('#connect-button').isDisabled() && await page.locator('#core-url').isDisabled();
    await page.waitForURL(workspace, { timeout: 240_000 });
    result.seconds = (Date.now() - clicked) / 1000;
    result.url = page.url();
    await shot('3-started-and-opened');
  } else if (step === 'click-start') {
    await offerStart();
    await page.locator('#start-button').click();
    result.duringStart = await status.textContent();
  } else if (step === 'running') {
    await page.goto(page_);
    result.answer = await page.evaluate((url) => window.__TAURI__.core.invoke('start_core', { url }), core);
    await page.goto(result.answer);
    result.url = page.url();
  } else if (step === 'twice') {
    await page.goto(page_);
    result.answers = await page.evaluate((url) => Promise.allSettled([
      window.__TAURI__.core.invoke('start_core', { url }),
      window.__TAURI__.core.invoke('start_core', { url }),
    ]).then((all) => all.map((one) => (one.status === 'fulfilled' ? { ok: one.value } : { error: String(one.reason) }))), core);
    const opened = result.answers.find((one) => one.ok);
    if (opened) await page.goto(opened.ok);
    result.url = page.url();
  } else if (step === 'refused') {
    // The start is offered after connecting fails, and its error is shown.
    if (!page.url().startsWith(page_)) await page.goto(page_);
    await page.getByText(/not reachable|Core returned HTTP|not a Yuzuno Core/).waitFor({ timeout: 30_000 });
    result.connectError = await status.textContent();
    result.startShown = await page.locator('#start-row').isVisible();
    result.startLabel = await page.locator('#start-button').textContent();
    await page.locator('#start-button').click();
    await page.waitForFunction(() => document.querySelector('#connection-message').dataset.error === 'true'
      && !document.querySelector('#start-button').disabled, null, { timeout: 240_000 });
    result.error = await status.textContent();
    result.url = page.url();
    await shot(`refused-${Date.now()}`);
  } else if (step === 'port-taken') {
    await offerStart();
    await page.locator('#start-button').click();
    await page.waitForFunction(() => !document.querySelector('#start-button').disabled, null, { timeout: 60_000 });
    result.error = await status.textContent();
    await shot('4-port-taken');
  } else {
    throw new Error(`unknown step ${step}`);
  }
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = String(error);
} finally {
  console.log(JSON.stringify(result));
  await browser.close(); // disconnects DevTools; the window stays open
}
