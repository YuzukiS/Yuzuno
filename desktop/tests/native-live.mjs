// Inspect a real Windows Tauri WebView2 process launched with a test-only CDP
// port. This connects to that window; it never substitutes a browser or Core.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '../../web/node_modules/playwright-core/index.mjs';

const endpoint = process.env.YUZUNO_NATIVE_CDP || 'http://127.0.0.1:9333';
const core = process.env.YUZUNO_CORE_URL || 'http://127.0.0.1:4317';
const output = resolve(process.env.YUZUNO_NATIVE_OUTPUT || 'acceptance/native');
await mkdir(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), endpoint, core, results: [] };
const browser = await chromium.connectOverCDP(endpoint);
try {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().startsWith(core));
  assert.ok(page, 'Expected the real Tauri window to connect to Core');
  await page.locator('.statusbar [data-core-status="Core connected"]').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('shell'), 'desktop');
  const health = await page.evaluate(async () => (await fetch('/api/health')).json());
  // This Core names its product; core.10 and older only the identifier.
  assert.ok(health.product === 'yuzuno' || (health.product === undefined && health.application === 'yuzuno-next'), JSON.stringify(health));
  const layout = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
    userAgent: navigator.userAgent,
  }));
  assert.ok(layout.scrollWidth <= layout.width, 'No native-window horizontal overflow');
  await page.screenshot({ path: resolve(output, 'native-workspace.png') });
  report.results.push({ name: 'real-webview2-core-load', url: page.url(), layout });

  const nativeBoundary = await page.evaluate(async () => {
    if (!window.__TAURI__?.core?.invoke) return { unavailable: true };
    try {
      await window.__TAURI__.core.invoke('connection_info');
      return { incorrectlyAllowed: true };
    } catch (error) { return { denied: String(error) }; }
  });
  assert.ok(nativeBoundary.unavailable || nativeBoundary.denied, 'Remote UI has no native connection permission');
  report.results.push({ name: 'remote-native-command-boundary', ...nativeBoundary });

  // Navigation is real WebView navigation. Native menu invocation is exercised
  // separately using Windows UI, rather than pretending a DOM click is a menu.
  await page.goto('http://tauri.localhost/index.html');
  await page.getByText('Choose a workspace, then connect.', { exact: true }).waitFor();
  await page.getByLabel('Workspace address').fill('http://127.0.0.1:4399');
  await page.locator('#connect-button').click();
  await page.getByText(/Core is not reachable yet/).waitFor();
  assert.equal(await page.locator('#connect-button').isEnabled(), true);
  await page.screenshot({ path: resolve(output, 'native-offline.png') });
  report.results.push({ name: 'real-native-offline-retry' });
  await page.getByLabel('Workspace address').fill(core);
  await page.locator('#connect-button').click();
  await page.waitForURL(`${core}/?shell=desktop`);
  await page.locator('.statusbar [data-core-status="Core connected"]').waitFor();
  report.results.push({ name: 'real-native-reconnect' });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  throw error;
} finally {
  await writeFile(resolve(output, 'native-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close(); // disconnects CDP; does not close the independently launched app
}
