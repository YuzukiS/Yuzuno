// Read-only GUI inspection of the completed native priority lab on 4379.
// Task dispatch and every other mutation are blocked before they reach Core.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lab = dirname(fileURLToPath(import.meta.url));
const base = 'http://127.0.0.1:4379';
const manifest = JSON.parse(await readFile(resolve(lab, 'priority-state.json'), 'utf8'));
const native = JSON.parse(await readFile(resolve(lab, 'native-state.json'), 'utf8'));
const reads = new Set(['task_list', 'task_get', 'peer_read', 'peers_list']);
const report = { startedAt: new Date().toISOString(), checks: [], failures: [], screenshots: [], blockedWrites: [], pageErrors: [] };
const record = (name, detail = {}) => { report.checks.push({ name, ...detail }); console.log(JSON.stringify({ check: name, ...detail })); };
async function api(path, input) {
  if (input !== undefined) assert.ok(reads.has(path), 'No domain mutations are permitted');
  const response = await fetch(`${base}/api/${input === undefined ? path : `collaboration/${path}`}`, input === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop' }, body: JSON.stringify(input),
  });
  assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
  return response.json();
}
const before = { workspace: await api('workspace'), task: await api('task_get', { taskId: manifest.taskId }), messages: await api('peer_read', { limit: 200 }) };
const { chromium } = await import(pathToFileURL(resolve(lab, '../../web/node_modules/playwright-core/index.mjs')));
const browser = await chromium.launch({ headless: true, executablePath: '/usr/sbin/chromium', args: ['--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await context.addInitScript(() => localStorage.setItem('yuzuno.appearance', JSON.stringify({ theme: 'light', fontSize: 20 })));
await context.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== base) return route.abort();
  if (['GET', 'HEAD'].includes(request.method())) return route.continue();
  const operation = url.pathname.match(/^\/api\/collaboration\/([^/]+)$/)?.[1];
  if (request.method() === 'POST' && reads.has(operation)) return route.continue();
  report.blockedWrites.push({ method: request.method(), path: url.pathname });
  return route.abort();
});
const page = await context.newPage();
page.setDefaultTimeout(12_000);
page.on('pageerror', error => report.pageErrors.push(error.message));
async function shot(name) {
  const path = resolve(lab, 'screenshots', `priority-${name}.png`);
  await page.screenshot({ path }); report.screenshots.push(path);
}
async function board() {
  if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Tasks & messages', exact: true }).click();
  await page.getByRole('dialog', { name: 'A place to work together' }).waitFor();
}
async function theme(value) {
  if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
  await page.locator(`input[name="appearance-theme"][value="${value}"]`).check();
  await page.keyboard.press('Escape');
}
async function geometry(name) {
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.collaboration, .collab-mailbox, .collab-message, .collab-detail')]
    .filter(e => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 2).map(e => e.className));
  assert.deepEqual(overflow, [], `${name} must not overflow`);
  assert.equal(await page.locator('html').getAttribute('data-font-size'), '20');
  record(name);
}
try {
  await page.goto(`${base}/?shell=desktop`);
  for (const attempt of manifest.attempts) {
    const palette = attempt.harness === 'codex' ? 'light' : 'dark';
    await theme(palette); await board();
    await page.getByRole('tab', { name: 'Messages', exact: true }).click();
    await page.locator('.collab-mailbox select').selectOption(attempt.agentId);
    const normal = page.locator(`#peer-message-${attempt.messageIds.normal}`);
    const urgent = page.locator(`#peer-message-${attempt.messageIds.urgent}`);
    await urgent.waitFor();
    assert.equal(await normal.locator('.collab-urgent-badge').count(), 0);
    assert.equal(await urgent.locator('.collab-urgent-badge').innerText(), 'Urgent');
    assert.match(await normal.locator('.collab-message-footer').innerText(), /Fetched by recipient.*Via new turn/s);
    assert.match(await urgent.locator('.collab-message-footer').innerText(), attempt.harness === 'codex' ? /Fetched by recipient.*Via active turn/s : /Fetched by recipient.*Via native hook/s);
    assert.equal(await urgent.getByRole('button', { name: `View task ${manifest.taskId}`, exact: true }).innerText(), manifest.taskId);
    assert.equal(await page.locator('#collab-messages form, #collab-messages textarea, #collab-messages input').count(), 0);
    await urgent.scrollIntoViewIfNeeded();
    await geometry(`${attempt.harness}-priority-desktop-${palette}-20px`); await shot(`${attempt.harness}-${palette}-desktop`);
    await page.setViewportSize({ width: 390, height: 844 });
    await urgent.scrollIntoViewIfNeeded();
    await geometry(`${attempt.harness}-priority-390-${palette}-20px`); await shot(`${attempt.harness}-${palette}-390`);
    await urgent.getByRole('button', { name: `View task ${manifest.taskId}`, exact: true }).click();
    await page.locator('.collab-detail .collab-task-id').waitFor();
    assert.equal(await page.locator('.collab-detail .collab-task-id').innerText(), manifest.taskId);
    record(`${attempt.harness}-message-opens-archived-canonical-task`, { taskId: manifest.taskId });
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  const codex = manifest.attempts.find(attempt => attempt.harness === 'codex');
  await theme('light'); await board();
  await page.getByRole('tab', { name: 'Messages', exact: true }).click();
  await page.locator('.collab-mailbox select').selectOption(codex.agentId);
  await page.locator(`#peer-message-${codex.messageIds.urgent}`).getByRole('button', { name: 'Recipient conversation', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const turn = page.locator(`[id="turn-${codex.originalTurnId}"]`);
  await turn.waitFor();
  const labels = await turn.locator('.user-message .message-label').allTextContents();
  assert.deepEqual(labels.map(text => text.trim()), ['YYou', 'Workspace mailbox']);
  assert.equal(await turn.locator('.user-message').first().locator('.mailbox-notice').count(), 0);
  assert.equal(await turn.locator('.mailbox-notice').count(), 1);
  assert.equal(await page.locator('.agent-row.selected').getAttribute('data-agent-id'), codex.agentId);
  await turn.scrollIntoViewIfNeeded(); await shot('codex-original-turn-authors');
  record('real-Codex-steer-preserves-original-user-and-attributes-only-mailbox-input', { agentId: codex.agentId, turnId: codex.originalTurnId, labels });
  for (const palette of ['light', 'dark']) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await theme(palette); await board();
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    const original = await api('task_get', { taskId: native.taskId });
    await page.locator(`.collab-task-card[data-task-id="${original.task.id}"]`).click();
    await page.getByRole('button', { name: 'Give to agent', exact: true }).click();
    const urgency = page.getByRole('checkbox', { name: 'Urgent · notify during current work', exact: true });
    assert.equal(await urgency.isChecked(), false); await urgency.check();
    assert.equal(await urgency.isChecked(), true);
    assert.equal(await page.getByRole('button', { name: 'Assign and send', exact: true }).isEnabled(), false, 'All lab agents are closed; no dispatch should be possible');
    await page.setViewportSize({ width: 390, height: 844 });
    await urgency.scrollIntoViewIfNeeded();
    await geometry(`dispatch-priority-choice-${palette}-390-20px`); await shot(`dispatch-choice-${palette}-390`);
  }
  assert.deepEqual((await api('task_get', { taskId: manifest.taskId })).task, before.task.task);
  assert.deepEqual(await api('peer_read', { limit: 200 }), before.messages);
  const after = await api('workspace');
  const identities = data => data.agents.map(agent => ({ id: agent.id, closedAt: agent.closedAt, threadId: agent.threadId, claudeSessionId: agent.claudeSessionId, lastSeq: agent.lastSeq }));
  assert.deepEqual(identities(after), identities(before.workspace));
  assert.equal(report.blockedWrites.filter(item => item.path.startsWith('/api/collaboration/')).length, 0);
  assert.deepEqual(report.pageErrors, []);
  record('no-native-work-no-peer-send-no-task-dispatch-no-domain-mutations');
} catch (error) {
  report.failures.push(String(error.stack || error));
  await shot('failure').catch(() => {});
} finally {
  await context.close(); await browser.close();
  report.finishedAt = new Date().toISOString();
  const path = resolve(lab, 'browser-priority-report.json');
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures, screenshots: report.screenshots, report: path }, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
