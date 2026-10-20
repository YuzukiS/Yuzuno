// One focused production UI flow; fully intercepted API, isolated browser.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';
import { idleJobsBudget, noCiRuns, noJobs, noLiveJobs, noReviews, unmanagedUpdates } from './browser-fixtures.mjs';
assert.ok(process.env.YUZUNO_UI_DIST, 'Use an isolated build');
const dist = resolve(process.env.YUZUNO_UI_DIST);
assert.notEqual(dist, resolve('dist'));
const output = resolve(process.env.YUZUNO_BROWSER_OUTPUT || '../target/t30-browser');
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], unexpected: [], reads: 0, refreshes: 0 };
const agent = { id: 'a', name: 'MCP fixture', status: 'idle', harness: 'claude', connectionState: 'connected',
  claudeSessionId: 'fixture-session', cwd: '/fixture', model: 'claude-sonnet-5', settings: {}, color: 'sage',
  createdAt: '', updatedAt: '', unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1 };
const statuses = ['connected', 'failed', 'needs-auth', 'pending', 'disabled', 'unknown'];
const observation = { observedAt: new Date().toISOString(), total: 6, truncated: false,
  servers: statuses.map((status, i) => ({ name: ['workspace', 'build-service', 'documents', 'starting-service', 'disabled-service', 'future-native-service'][i], status, reason: 'connection' })) };
const view = { state: 'ready', reason: 'observed', generation: 1, sessionId: 'fixture-session', checkedAt: observation.observedAt,
  stale: false, freshForSeconds: 60, observation };
let held, routeReady, next = view;
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || '/usr/sbin/chromium' });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.EventSource = class { close() {} };
    localStorage.setItem('yuzuno.appearance', JSON.stringify({ theme: 'light', fontSize: 16, palette: 'garden' }));
    localStorage.setItem('yuzuno.selected', JSON.stringify('a'));
  });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.hostname, 'yuzuno-mcp-status.test');
    if (url.pathname === '/api/agents/a/claude/mcp-status') {
      if (request.method() === 'POST') { report.refreshes++; held = route; routeReady?.(); return; }
      assert.equal(request.method(), 'GET'); report.reads++;
      return route.fulfill({ json: next });
    }
    assert.equal(request.method(), 'GET', `Unexpected mutation ${url.pathname}`);
    const json = {
      '/api/workspace': { agents: [agent], runtime: { connected: true }, defaultCwd: '/fixture' },
      '/api/agents/a': { agent, pending: [], messageReceipts: [], artifacts: [], turns: [] },
      '/api/updates': unmanagedUpdates, '/api/jobs/budget': idleJobsBudget, '/api/jobs': noJobs,
      '/api/jobs/live': noLiveJobs, '/api/ci': noCiRuns, '/api/reviews': noReviews,
      '/api/catchup': { items: [], generatedAt: '', source: 'records', coverage: { fromSeq: 0, toSeq: 0 } },
      // Claude's quota auto-continue (T-94): off, nothing waiting.
      '/api/agents/a/claude/auto-continue': { workspace: false, agent: null, enabled: false, intent: null, stopped: null },
    }[url.pathname];
    if (json) return route.fulfill({ json });
    if (url.pathname.startsWith('/api/')) { report.unexpected.push(url.pathname); return route.fulfill({ json: {} }); }
    const file = resolve(dist, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    assert.ok(file.startsWith(dist + '/'));
    await route.fulfill({ body: await readFile(file), contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' }[extname(file)] });
  });
  await page.goto('http://yuzuno-mcp-status.test/');
  const panel = page.getByRole('region', { name: 'Claude MCP services' });
  await panel.locator('.mcp-server-state').nth(5).waitFor();
  assert.deepEqual(await panel.locator('.mcp-server-state').allTextContents(), ['Connected', 'Failed', 'Needs authentication', 'Connecting', 'Disabled', 'Unknown']);
  await panel.scrollIntoViewIfNeeded();
  const layout = await panel.evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth, inDl: !!el.closest('dl'),
    text: getComputedStyle(el.querySelector('.mcp-status-note')).color }));
  assert.equal(layout.inDl, false); assert.ok(layout.width > 160 && layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
  assert.match(await panel.getByRole('link', { name: 'Authentication help' }).getAttribute('href'), /code\.claude\.com/);
  // The context panel lists the conversation's Artifacts first, MCP services after.
  assert.ok(await page.evaluate(() => {
    const artifacts = document.querySelector('.inspector [aria-label="Artifacts"]'), mcp = document.querySelector('.inspector .claude-mcp-status');
    return !!artifacts && !!mcp && !!(artifacts.compareDocumentPosition(mcp) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), 'Artifacts come before MCP services');
  await page.screenshot({ path: resolve(output, 'mcp-status.png') });
  report.checks.push('Six states, safe reason, official authentication help, compact independent section without overflow');
  const refresh = panel.getByRole('button', { name: 'Refresh MCP status' });
  let intercepted = new Promise(resolve => { routeReady = resolve; });
  await refresh.focus(); await page.keyboard.press('Enter');
  await intercepted;
  await page.waitForFunction(() => document.querySelector('.claude-mcp-status button').disabled);
  await refresh.evaluate(el => { el.click(); el.click(); });
  assert.equal(report.refreshes, 1);
  assert.ok(held);
  await held.fulfill({ json: { ...view, state: 'failed', reason: 'read_failed', stale: true } });
  await panel.getByText('Could not read MCP status. Try refreshing.').waitFor();
  assert.match(await panel.innerText(), /Previous observation/);
  assert.equal(await panel.locator('[data-state=connected]').count(), 0);
  report.checks.push('Keyboard refresh coalesces duplicate clicks; failed read retains explicitly stale observation');
  intercepted = new Promise(resolve => { routeReady = resolve; });
  await refresh.click();
  await intercepted;
  await page.waitForFunction(() => document.querySelector('.claude-mcp-status button').disabled);
  await held.fulfill({ json: { ...view, observation: { ...observation, servers: [{ name: 'recovered-service', status: 'connected' }], total: 1 } } });
  await panel.getByText('recovered-service').waitFor();
  assert.doesNotMatch(await panel.innerText(), /Previous observation|Could not read/);
  assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpected, []);
  report.checks.push('Successful refresh restores current observation; no model, reconnect or authentication writes');
} finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
console.log(JSON.stringify(report));
