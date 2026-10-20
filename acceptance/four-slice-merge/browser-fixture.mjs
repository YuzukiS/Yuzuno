// Combined UI acceptance against the built candidate. All API responses belong
// to this ephemeral fixture; it cannot connect to a Core or run a Harness.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../web/node_modules/playwright-core/index.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.join(root, 'web/dist');
const output = fileURLToPath(new URL('./browser', import.meta.url));
await mkdir(output, { recursive: true });
await stat(path.join(dist, 'index.html'));
const now = new Date().toISOString();
const threadId = '019a1234-5678-4321-aaaa-123456789abc';
const baseAgent = {
  goal: '', cwd: '/fixture/yuzuno-next', color: 'sage', model: 'claude-opus-fixture',
  status: 'waiting', connectionState: 'connected', createdAt: now, updatedAt: now,
  lastSeq: 12, reviewedSeq: 12, unreadCount: 0, pendingCount: 1,
  settings: { reasoningEffort: null, approvalPolicy: 'on-request', sandbox: 'workspace-write', permissionMode: 'default' },
};
const momo = { ...baseAgent, id: 'claude-fixture', name: 'Momo', harness: 'claude', projectId: 'yuzu', claudeSessionId: threadId };
const hana = { ...baseAgent, id: 'codex-fixture', name: 'Hana', harness: 'codex', model: 'codex-fixture', projectId: 'notes' };
const projects = [
  { id: 'yuzu', name: 'Yuzuno development', defaultDirs: { local: '/fixture/yuzuno-next' }, createdAt: now, updatedAt: now },
  { id: 'notes', name: 'Reading notes', defaultDirs: { local: '/fixture/notes' }, createdAt: now, updatedAt: now },
];
const permission = {
  id: 'permission-fixture', agentId: momo.id, method: 'claude/canUseTool', createdAt: now,
  params: {
    requestId: 'native-fixture', turnId: 'turn-fixture', toolName: 'Bash', input: { command: 'npm test' },
    sessionPermissions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] }],
  },
};
const nativeTurn = {
  id: 'turn-fixture', status: 'inProgress', items: [
    { id: 'user-fixture', type: 'userMessage', content: [{ type: 'text', text: 'Check this integration and tell me what needs my attention.' }] },
    { id: 'comment-fixture', type: 'agentMessage', phase: 'commentary', text: 'The session history and project scope are ready. I’m checking the combined interface now.' },
    { id: 'thinking-fixture', type: 'reasoning', summary: ['I will verify the merged controls and keep each native session intact.'] },
    { id: 'tool-fixture', type: 'claudeToolUse', name: 'Bash', input: { command: 'npm test' }, status: 'inProgress' },
  ],
};
const claudeRuntime = {
  account: { email: 'fixture@example.invalid', subscriptionType: 'Claude Max' }, version: '2.1.280',
  model: 'claude-opus-fixture', permissionMode: 'acceptEdits', contextWindow: 1000000,
  rateLimitsAt: now,
  rateLimits: { status: 'allowed', unifiedWindows: {
    five_hour: { utilization: 0.21, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
    seven_day: { utilization: 0.36, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
  } },
};
const report = { checks: [], pageErrors: [], unexpectedRequests: [], blockedExternalRequests: [], writes: [], screenshots: [], passed: false };
const requests = [];
let approved = false;
function detail(agent) {
  return { agent, turns: agent.id === momo.id ? [nativeTurn] : [], pending: agent.id === momo.id && !approved ? [permission] : [], artifacts: [], messageReceipts: [],
    ...(agent.id === momo.id ? { contextUsage: { usedTokens: 370000, windowTokens: 1000000, usedPercent: 37, turnId: nativeTurn.id, updatedAt: now, stale: false }, claudeRuntime } : {}) };
}
const models = { models: [{ id: momo.model, model: momo.model, displayName: 'Claude Opus · fixture', supportsAutoMode: true }] };
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture.invalid');
    if (url.pathname.startsWith('/api/')) {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 65536) throw new Error('Oversized fixture request');
      }
      const body = raw ? JSON.parse(raw) : null;
      const request = { method: req.method, path: url.pathname, query: url.search, body };
      requests.push(request);
      let data;
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(': fixture connected\n\n');
        return;
      }
      if (req.method === 'GET') {
        if (url.pathname === '/api/workspace') data = { workspace: { id: 'merge-fixture' }, projects, agents: [momo, hana], runtime: { connected: true, version: 'fixture' }, defaultCwd: momo.cwd };
        else if (url.pathname === `/api/agents/${momo.id}`) data = detail(momo);
        else if (url.pathname === `/api/agents/${hana.id}`) data = detail(hana);
        else if (url.pathname.endsWith('/models') || url.pathname === '/api/models') data = models;
        else if (url.pathname === '/api/machines') data = { machines: [{ id: 'local', name: 'Core host', kind: 'local', defaultCwd: momo.cwd }] };
        else if (url.pathname === '/api/projects') data = { projects };
        else if (url.pathname === '/api/catchup') data = { generatedAt: now, items: [], source: 'records', coverage: { fromSeq: 0, toSeq: 12 } };
      } else if (req.method === 'POST') {
        // These are synthetic responses. No request is ever proxied to a Core.
        if (url.pathname === `/api/agents/${momo.id}/settings`) {
          assert.equal(body.permissionMode, 'default');
          assert.equal(body.model, momo.model);
          claudeRuntime.permissionMode = 'default';
          data = detail(momo);
        } else if (url.pathname === `/api/requests/${permission.id}/respond`) {
          assert.deepEqual(body, { response: { decision: 'allow', scope: 'session' } });
          approved = true;
          data = {};
        } else if (url.pathname === '/api/codex/sessions/preview') {
          assert.equal(body.threadId, threadId);
          data = { threadId, name: 'Existing development conversation', cwd: '/fixture/yuzuno-next', preview: 'A saved conversation ready to continue.', model: 'codex-fixture', reasoningEffort: 'high', turnCount: 48, updatedAt: Date.now() / 1000, existingAgentId: null, warnings: [], permissions: { presets: ['ask', 'auto', 'full', 'config'].map(id => ({ id, available: true })) } };
        }
        if (data !== undefined) report.writes.push(request);
      }
      if (data === undefined) {
        report.unexpectedRequests.push(request);
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unexpected fixture operation; no Core was contacted' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) throw new Error('Static fixture is read-only');
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(dist, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(dist + path.sep)) throw new Error('Invalid static path');
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch (error) {
    if (error.code === 'ENOENT') { res.writeHead(404); res.end(); return; }
    report.pageErrors.push(error.message);
    res.writeHead(500); res.end('Fixture failure');
  }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.YUZUNO_BROWSER_BIN || '/usr/sbin/chromium', headless: true, args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    report.blockedExternalRequests.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(({ selected }) => {
    localStorage.setItem('yuzuno.selected', selected);
    localStorage.setItem('yuzuno.appearance', JSON.stringify({ theme: 'light', fontSize: 20 }));
    Object.defineProperty(document, 'hasFocus', { value: () => false });
  }, { selected: momo.id });
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(base + '/?shell=desktop');
  await page.getByRole('heading', { name: momo.name, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Context: 37% used', exact: true }).waitFor();
  assert.match(await page.locator('.inspector').textContent(), /fixture@example\.invalid/);
  assert.match(await page.locator('.inspector').textContent(), /5h 21% · 7d 36%/);
  await page.getByRole('button', { name: 'Allow for this session', exact: true }).waitFor();
  assert.match(await page.locator('.claude-permission').textContent(), /Bash\(npm test:\*\)/);
  for (const details of await page.locator('details.execution').all()) {
    if (!await details.evaluate(el => el.open)) await details.locator(':scope > summary').click();
  }
  await page.locator('#item-thinking-fixture > summary').click();
  await page.getByText('I will verify the merged controls and keep each native session intact.', { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400); // Let disclosure motion finish before inspecting it.
  const factLayout = await page.locator('.inspector dd').evaluateAll(nodes => nodes.map(node => ({
    text: node.textContent.trim(), width: node.clientWidth, content: node.scrollWidth,
    right: node.getBoundingClientRect().right, edge: node.closest('.inspector').getBoundingClientRect().right,
  })));
  report.factLayout = factLayout;
  for (const fact of factLayout) {
    assert.ok(fact.content <= fact.width + 1 && fact.right <= fact.edge + 1, `Inspector fact fits its column: ${fact.text}`);
  }
  report.checks.push('Claude reasoning summary, real-shaped context, account and native session grant render together');
  async function screenshot(name) {
    const file = `${name}.png`;
    await page.screenshot({ path: path.join(output, file) });
    report.screenshots.push(file);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no horizontal page overflow`);
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await screenshot(`claude-${theme}-1440-20px`);
  }
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
  await page.getByText('This session is currently in acceptEdits mode.', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('Approvals', { exact: true }).inputValue(), 'default');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await screenshot(`claude-settings-${theme}-20px`);
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  assert.equal(report.writes.filter(request => request.path.endsWith('/settings')).length, 1);
  report.checks.push('Saving chosen default explicitly resets an observed acceptEdits mode');

  await page.locator('.workspace-scope').click();
  await page.getByRole('menuitemradio', { name: /Yuzuno development/ }).click();
  await page.getByRole('button', { name: 'Open Momo', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Open Hana', exact: true }).count(), 0);
  await page.getByText('1 waiting in other projects', { exact: true }).waitFor();
  report.checks.push('Project scope filters the Agent Rail and preserves outside-project attention');
  await screenshot('project-scope-dark-20px');

  await page.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByRole('button', { name: 'Existing Codex session', exact: true }).click();
  await page.getByLabel('Codex session ID', { exact: true }).fill(threadId);
  await page.getByRole('button', { name: 'Preview session', exact: true }).click();
  await page.locator('.session-preview').waitFor();
  await page.getByRole('button', { name: 'Add to workspace', exact: true }).waitFor();
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.locator('.modal').evaluate(el => { el.scrollTop = 0; });
    await screenshot(`session-import-${theme}-${width}-20px`);
    assert.ok(await page.locator('.modal').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Import dialog does not overflow');
    if (width === 390) {
      await page.getByRole('button', { name: 'Add to workspace', exact: true }).scrollIntoViewIfNeeded();
      await screenshot(`session-import-${theme}-${width}-20px-action`);
    }
  }
  report.checks.push('Session import is reachable with an active Project scope; preview has no import or turn side effect');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.getByRole('button', { name: 'Allow for this session', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.claude-permission'));
  assert.equal(report.writes.filter(request => request.path.endsWith('/respond')).length, 1);
  report.checks.push('Allow for this session sends the exact synthetic approval scope once');
  assert.equal(report.unexpectedRequests.length, 0, JSON.stringify(report.unexpectedRequests));
  assert.equal(report.blockedExternalRequests.length, 0);
  assert.equal(report.pageErrors.length, 0, report.pageErrors.join('\n'));
  assert.equal(report.writes.length, 3, 'Only fixture settings, preview and approval were written');
  assert.ok(!requests.some(request => /\/(turns|messages|import)$/.test(request.path)), 'No Turn, message or import was submitted');
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, failure: report.failure, report: path.join(output, 'report.json') }, null, 2));
}
