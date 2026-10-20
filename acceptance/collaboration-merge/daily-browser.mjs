// Read-only post-cutover inspection in an independent headless browser.
// No user window, model turn, task creation, permission save, or read receipt.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const output = dirname(fileURLToPath(import.meta.url));
const screenshots = resolve(output, 'screenshots');
const plan = JSON.parse(await readFile(resolve(output, 'plan.json'), 'utf8'));
const base = 'http://127.0.0.1:4317';
const { chromium } = await import(pathToFileURL(resolve(output, '../../web/node_modules/playwright-core/index.mjs')));
const report = { startedAt: new Date().toISOString(), checks: [], screenshots: [],
  browserErrors: [], httpErrors: [], blockedWrites: [], readOperations: [],
  scope: 'Independent headless Chromium; document.hasFocus=false. Only GET/HEAD and user-identity collaboration read operations can reach Core.' };
const readOperations = new Set(['task_list', 'task_get', 'peer_read', 'peers_list']);
const get = async path => {
  const response = await fetch(`${base}/api${path}`, { signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok, `GET ${path}: ${response.status}`);
  return response.json();
};
const read = async operation => {
  assert.ok(readOperations.has(operation));
  const response = await fetch(`${base}/api/collaboration/${operation}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop' },
    body: '{}', signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, `Read ${operation}: ${response.status}`);
  return response.json();
};
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(test, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await test(); if (result) return result; await sleep(100); }
  throw Error('Read-only browser condition timed out');
}
const workspace = await get('/workspace');
const wanted = plan.reconnectAgentIds || workspace.agents.filter(a => !a.closedAt && ['Dev 1', 'Dev 2'].includes(a.name)).map(a => a.id);
assert.equal(wanted.length, 2, 'Expected the two previously connected development Agents');
const before = new Map();
for (const id of wanted) before.set(id, await get(`/agents/${id}`));
assert.deepEqual([...before.values()].map(d => d.agent.name).sort(), ['Dev 1', 'Dev 2']);
const boardBefore = { tasks: await read('task_list'), messages: await read('peer_read') };
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/usr/sbin/chromium', args: ['--disable-dev-shm-usage'] });
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(({ id }) => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    localStorage.setItem('yuzuno.selected', JSON.stringify(id));
    localStorage.setItem('yuzuno.appearance', JSON.stringify({ theme: 'light', fontSize: 20 }));
  }, { id: wanted[0] });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) return route.abort();
    if (['GET', 'HEAD'].includes(request.method())) return route.continue();
    const operation = url.pathname.match(/^\/api\/collaboration\/([^/]+)$/)?.[1];
    if (request.method() === 'POST' && readOperations.has(operation)) {
      // This is the GUI/user endpoint, never the Agent-authenticated MCP route;
      // user peer_read only observes existing fetched receipts.
      report.readOperations.push(operation);
      return route.continue();
    }
    report.blockedWrites.push({ method: request.method(), path: url.pathname });
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(25_000);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 400) report.httpErrors.push({ status: response.status(), path: new URL(response.url()).pathname });
  });
  async function shot(name) {
    const path = resolve(screenshots, `${name}.png`);
    await page.screenshot({ path, fullPage: false });
    report.screenshots.push(path);
  }
  async function geometry(name) {
    const layout = await page.evaluate(() => {
      const rect = document.querySelector('[role="dialog"]')?.getBoundingClientRect();
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
        theme: document.documentElement.dataset.theme, fontSize: document.documentElement.dataset.fontSize,
        readingSize: getComputedStyle(document.documentElement).getPropertyValue('--reading-size').trim(),
        dialog: rect && { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } };
    });
    assert.equal(layout.fontSize, '20');
    assert.equal(layout.readingSize, '20px');
    assert.ok(layout.documentWidth <= layout.width + 2, `${name}: page horizontal overflow`);
    if (layout.dialog) {
      assert.ok(layout.dialog.left >= -1 && layout.dialog.right <= layout.width + 1, `${name}: dialog horizontal overflow`);
      assert.ok(layout.dialog.top >= -1 && layout.dialog.bottom <= layout.height + 1, `${name}: dialog vertical overflow`);
    }
    report.checks.push({ name, ...layout });
  }
  async function closeDialog() {
    if (await page.getByRole('dialog').count()) {
      await page.keyboard.press('Escape');
      await until(async () => await page.getByRole('dialog').count() === 0);
    }
  }
  async function openBoard() {
    await closeDialog();
    await page.getByRole('button', { name: 'Tasks & messages', exact: true }).click();
    await page.getByRole('dialog', { name: 'A place to work together' }).waitFor();
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    await until(async () => !await page.locator('.collab-loading').count());
  }
  async function appearance(theme) {
    await closeDialog();
    await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
    await page.locator(`input[name="appearance-theme"][value="${theme}"]`).check();
    await page.locator('input[name="appearance-font-size"][value="20"]').check();
    await closeDialog();
    await until(async () => await page.evaluate(() => document.documentElement.dataset.theme) === theme);
  }
  async function checkPermissions() {
    await closeDialog();
    const codex = [...before.values()].find(d => d.agent.harness !== 'claude');
    assert.ok(codex, 'Expected a Codex development Agent');
    await page.getByRole('button', { name: `Open ${codex.agent.name}`, exact: true }).click();
    await page.getByRole('heading', { name: codex.agent.name, exact: true }).waitFor();
    const button = page.getByRole('button', { name: 'Agent settings', exact: true });
    assert.ok((await button.innerText()).includes('reasoning'));
    await button.click();
    const dialog = page.getByRole('dialog');
    const select = dialog.getByLabel('Permissions', { exact: true });
    await select.waitFor();
    await until(async () => await select.isEnabled());
    const options = await select.locator('option').allTextContents();
    for (const label of ['Ask for approval', 'Approve for me', 'Full access', 'Follow Codex config']) {
      assert.ok(options.some(option => option === label || option.startsWith(`${label} ·`)), `Missing Permissions option: ${label}`);
    }
    report.checks.push({ name: 'Model & reasoning exposes all four Permissions choices without saving', options });
  }

  await page.goto(`${base}/?shell=desktop`);
  for (const id of wanted) {
    const previous = before.get(id);
    await page.getByRole('button', { name: `Open ${previous.agent.name}`, exact: true }).click();
    await page.getByRole('heading', { name: previous.agent.name, exact: true }).waitFor();
    assert.ok(previous.turns.length, 'Existing development conversation must have history');
    await until(async () => await page.locator('.conversation-inner [data-turn-id]').count() === previous.turns.length);
    const ids = await page.locator('.conversation-inner [data-turn-id]').evaluateAll(elements => elements.map(e => e.getAttribute('data-turn-id')));
    assert.deepEqual(ids, previous.turns.map(turn => turn.id));
    const text = await page.locator('.conversation-inner').innerText();
    assert.ok(text.trim().length > 100, 'Historical conversation is not empty');
    assert.ok(await page.locator('.conversation-inner .agent-message .prose').count(), 'Historical Agent replies render');
    report.checks.push({ name: `${previous.agent.name} history displayed`, agentId: id, turns: ids.length });
    await geometry(`${previous.agent.name}-light-20px`);
    await shot(`${previous.agent.name.toLowerCase().replaceAll(' ', '-')}-history`);
  }
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await appearance(theme);
    await checkPermissions();
    await geometry(`permissions-${theme}-desktop`);
    await shot(`permissions-${theme}-20px`);
    await closeDialog();
    await openBoard();
    await page.getByRole('tabpanel', { name: 'Tasks', exact: true }).waitFor();
    assert.equal(await page.locator('#collab-tasks form').count(), 0, 'Opening Tasks does not open a composer');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await geometry(`tasks-${theme}-${width}`);
      await shot(`tasks-${theme}-${width}`);
    }
    await page.getByRole('tab', { name: 'Messages', exact: true }).click();
    await page.getByRole('tabpanel', { name: 'Messages', exact: true }).waitFor();
    await until(async () => !await page.locator('.collab-loading').count());
    assert.equal(await page.locator('#collab-messages form, #collab-messages textarea, #collab-messages input, .collab-message-compose').count(), 0);
    for (const label of ['Reply as you', 'Follow up', 'Send message']) {
      assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 0);
    }
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await geometry(`messages-${theme}-${width}`);
      await shot(`messages-${theme}-${width}`);
    }
    report.checks.push({ name: `Messages is observation-only (${theme})` });
    await closeDialog();
  }
  assert.equal(await page.evaluate(() => document.hasFocus()), false);
  for (const [id, previous] of before) {
    const after = await get(`/agents/${id}`);
    for (const key of ['id', 'name', 'threadId', 'claudeSessionId', 'settings', 'reviewedSeq']) {
      assert.deepEqual(after.agent[key], previous.agent[key], `Browser changed ${previous.agent.name}/${key}`);
    }
    assert.deepEqual(after.turns, previous.turns, 'Browser altered transcript');
  }
  assert.deepEqual(await read('task_list'), boardBefore.tasks, 'Browser altered tasks');
  assert.deepEqual(await read('peer_read'), boardBefore.messages, 'Browser altered mail/read receipts');
  assert.equal(report.blockedWrites.length, 0, 'UI attempted a write despite read-only inspection');
  assert.equal(report.browserErrors.length, 0);
  assert.equal(report.httpErrors.length, 0);
  report.checks.push({ name: 'Native sessions, transcripts, settings, conversation read cursors, tasks and mailbox receipts unchanged' });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.stack || String(error);
  process.exitCode = 1;
  if (page) await page.screenshot({ path: resolve(screenshots, 'failure.png'), fullPage: false }).catch(() => {});
} finally {
  await browser.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'daily-browser-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length,
    blockedWrites: report.blockedWrites.length, browserErrors: report.browserErrors.length,
    httpErrors: report.httpErrors.length, error: report.error,
    report: resolve(output, 'daily-browser-report.json') }));
}
