// Read-only inspection of the real, isolated collaboration lab. No mock data,
// additional tasks, model turns, daily Core, or user's browser are involved.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lab = dirname(fileURLToPath(import.meta.url));
const screenshots = resolve(lab, 'screenshots');
const base = 'http://127.0.0.1:4379';
const layoutOnly = process.argv.includes('--layout-only');
const { chromium } = await import(pathToFileURL(resolve(lab, '../../web/node_modules/playwright-core/index.mjs')));
const report = {
  mode: layoutOnly ? 'read-only layout on real data' : 'read-only real collaboration', startedAt: new Date().toISOString(),
  checks: [], failures: [], warnings: [], screenshots: [], layout: [], browserErrors: [],
  readRequests: [], blockedWrites: [],
};
const readOperations = new Set(['task_list', 'task_get', 'peer_read', 'peers_list']);
const sleep = ms => new Promise(done => setTimeout(done, ms));
const record = (name, detail = {}) => {
  report.checks.push({ name, ...detail });
  console.log(JSON.stringify({ check: name, ...detail }));
};
async function state() { return JSON.parse(await readFile(resolve(lab, 'native-state.json'), 'utf8')); }
async function api(operation, input = {}) {
  assert.ok(readOperations.has(operation), 'This browser script cannot mutate collaboration data');
  const response = await fetch(`${base}/api/collaboration/${operation}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop' }, body: JSON.stringify(input),
  });
  assert.ok(response.ok, `${operation}: ${await response.clone().text()}`);
  return response.json();
}
async function until(check, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await sleep(100); }
  throw Error('Read-only acceptance condition timed out');
}

await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: '/usr/sbin/chromium', args: ['--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await context.addInitScript(() => {
  localStorage.setItem('yuzuno.appearance', JSON.stringify({ theme: 'light', fontSize: 20 }));
});
// Read APIs use POST. Every other non-read request is stopped before Core sees it,
// including the ordinary conversation auto-read hook triggered by navigation.
await context.route('**/*', async route => {
  const request = route.request(); const url = new URL(request.url());
  if (url.origin !== base) return route.abort();
  if (['GET', 'HEAD'].includes(request.method())) return route.continue();
  const operation = url.pathname.match(/^\/api\/collaboration\/([^/]+)$/)?.[1];
  if (request.method() === 'POST' && readOperations.has(operation)) {
    report.readRequests.push(operation); return route.continue();
  }
  report.blockedWrites.push({ method: request.method(), path: url.pathname });
  return route.abort();
});
const page = await context.newPage();
page.on('pageerror', error => report.browserErrors.push(error.message));
page.setDefaultTimeout(12_000);
async function screenshot(name) {
  const path = resolve(screenshots, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  report.screenshots.push(path); console.log(JSON.stringify({ screenshot: path }));
}
async function geometry(name) {
  const layout = await page.evaluate(() => {
    const modal = document.querySelector('[role="dialog"]');
    const rect = modal?.getBoundingClientRect();
    return {
      width: innerWidth, height: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      theme: document.documentElement.dataset.theme,
      fontSize: document.documentElement.dataset.fontSize,
      readingSize: getComputedStyle(document.documentElement).getPropertyValue('--reading-size').trim(),
      modal: rect && { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      horizontalOverflow: [...document.querySelectorAll('.collaboration, .collab-task-list, .collab-task-detail, .collab-task-card, .collab-mailbox, .collab-message')]
        .filter(e => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 2)
        .map(e => ({ className: e.className, clientWidth: e.clientWidth, scrollWidth: e.scrollWidth })),
    };
  });
  report.layout.push({ name, ...layout });
  assert.equal(layout.fontSize, '20'); assert.equal(layout.readingSize, '20px');
  assert.ok(layout.documentWidth <= layout.width + 2, `${name}: page overflows horizontally`);
  if (layout.modal) {
    assert.ok(layout.modal.left >= -1 && layout.modal.right <= layout.width + 1, `${name}: dialog outside viewport horizontally`);
    assert.ok(layout.modal.top >= -1 && layout.modal.bottom <= layout.height + 1, `${name}: dialog outside viewport vertically`);
  }
  assert.equal(layout.horizontalOverflow.length, 0, `${name}: panel horizontal overflow`);
  record(name, { viewport: `${layout.width}×${layout.height}`, theme: layout.theme, fontSize: layout.fontSize });
}
async function stage(name, run) {
  try { await run(); }
  catch (error) {
    report.failures.push({ stage: name, error: String(error.stack || error) });
    console.log(JSON.stringify({ failure: name, error: String(error) }));
    await screenshot(`failure-${name}`).catch(() => {});
  }
}
async function openBoard() {
  if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Tasks & messages', exact: true }).click();
  await page.getByRole('dialog', { name: 'A place to work together' }).waitFor();
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
}
async function selectTask(task) {
  await page.locator('.collab-task-card').filter({ has: page.getByRole('heading', { name: task.title, exact: true }) }).click();
  await page.locator('.collab-result').waitFor();
}
async function appearance(theme) {
  if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
  await page.locator(`input[name="appearance-theme"][value="${theme}"]`).check();
  await page.locator('input[name="appearance-font-size"][value="20"]').check();
  await page.keyboard.press('Escape');
  await until(async () => await page.getByRole('dialog').count() === 0);
  const restored = await until(async () => page.getByRole('button', { name: 'Appearance settings' }).evaluate(e => e === document.activeElement), 1000).catch(() => false);
  if (!restored) report.warnings.push({ name: 'appearance-dialog-focus-return', detail: 'Escape closes the existing Appearance dialog, but keyboard focus did not return to its launcher.' });
}
try {
  await page.goto(base + '/?shell=desktop');
  await page.getByRole('button', { name: 'Tasks & messages', exact: true }).waitFor();
  await openBoard();
  await stage('initial-real-board', async () => { await geometry('initial-real-board'); await screenshot('initial-light-20px'); });

  if (layoutOnly) {
    const manifest = await state();
    const actual = await api('task_get', { taskId: manifest.taskId });
    for (const theme of ['light', 'dark']) {
      await stage(`layout-only-${theme}`, async () => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await appearance(theme); await openBoard(); await selectTask(actual.task);
        await geometry(`real-task-${theme}-desktop`); await screenshot(`layout-task-${theme}-desktop`);
        for (const width of [680, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await geometry(`real-task-${theme}-${width}`); await screenshot(`layout-task-${theme}-${width}`);
        }
        await page.getByRole('tab', { name: 'Messages', exact: true }).click();
        await page.locator('.collab-mailbox select').selectOption(manifest.agents[0]);
        await until(async () => !await page.locator('.collab-loading').count());
        await geometry(`real-messages-${theme}-390`); await screenshot(`layout-messages-${theme}-390`);
        await page.keyboard.press('Escape');
        await until(async () => await page.getByRole('dialog').count() === 0);
        record(`Escape-closes-${theme}-narrow-board`);
      });
    }
  } else {

  // The parent runs the only real native scenario. Waiting here never starts one.
  const deadline = Date.now() + 240_000;
  let manifest = await state();
  let lastNotice = 0;
  while (!manifest.checks?.length && Date.now() < deadline) {
    if (Date.now() - lastNotice > 30_000) { console.log('Waiting for parent native acceptance; browser remains read-only.'); lastNotice = Date.now(); }
    await sleep(1000); manifest = await state();
  }
  assert.ok(manifest.checks?.length, 'Parent native acceptance has not completed; no mock fallback is permitted');
  const original = await api('task_get', { taskId: manifest.taskId });
  assert.ok(original.task.result?.summary, 'Inspect a real submitted result');
  report.realTask = { id: original.task.id, title: original.task.title, version: original.task.version, status: original.task.status };
  record('real-native-scenario-ready', { taskId: manifest.taskId, nativeChecks: manifest.checks.length });

  await stage('desktop-light-real-result', async () => {
    await openBoard(); await page.getByRole('button', { name: 'Refresh tasks', exact: true }).click();
    await selectTask(original.task);
    assert.equal(await page.locator('.collab-task-card').count(), (await api('task_list')).tasks.length);
    assert.ok((await page.locator('.collab-result').innerText()).includes(original.task.result.summary));
    await geometry('desktop-light-real-result'); await screenshot('tasks-light-20px-desktop');
    assert.equal(await page.getByRole('button', { name: 'View original conversation', exact: true }).count(), 1);
  });
  await stage('result-source-jump', async () => {
    const source = original.task.result.source;
    assert.ok(source?.agentId && source?.turnId, 'Real submitted result must have its precise Turn source');
    await page.getByRole('button', { name: 'View original conversation', exact: true }).click();
    await until(async () => await page.getByRole('dialog').count() === 0);
    const turn = page.locator(`[id="turn-${source.turnId}"]`);
    await turn.waitFor();
    await until(async () => turn.evaluate(e => {
      const rect = e.getBoundingClientRect(), pane = document.querySelector('.conversation-scroll')?.getBoundingClientRect();
      return !!pane && rect.bottom > pane.top && rect.top >= pane.top - 30 && rect.top <= pane.top + 65;
    }));
    const selected = await page.locator('.agent-row.selected').getAttribute('data-agent-id');
    assert.equal(selected, source.agentId);
    record('result-source-jump', { agentId: source.agentId, turnId: source.turnId });
    await screenshot('real-result-original-turn');
  });
  await stage('desktop-dark-and-messages', async () => {
    await appearance('dark'); await openBoard(); await selectTask(original.task);
    await geometry('desktop-dark-real-result'); await screenshot('tasks-dark-20px-desktop');
    await page.getByRole('tab', { name: 'Messages', exact: true }).click();
    await page.locator('.collab-mailbox select').selectOption(manifest.agents[1]);
    await page.locator('.collab-message').first().waitFor();
    const expected = (await api('peer_read', { agentId: manifest.agents[1] })).messages;
    await until(async () => await page.locator('.collab-message').count() === expected.length);
    const renderedBodies = await page.locator('.collab-message .prose').allTextContents();
    assert.ok(renderedBodies.every(body => body.trim().length > 0), 'Real messages render readable content');
    assert.equal(await page.locator('#collab-messages form, #collab-messages textarea, #collab-messages input, .collab-message-compose').count(), 0, 'Messages has no user composer');
    for (const name of ['Reply as you', 'Follow up', 'Send message']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
    const linkedIds = await page.locator('.collab-message-task span').allTextContents();
    assert.ok(linkedIds.length > 0, 'Native collaboration retains task links');
    assert.ok(linkedIds.every(id => /^T-[1-9]\d*$/.test(id)), 'Task references use canonical short IDs');
    report.renderedMessages = renderedBodies;
    await geometry('desktop-dark-messages'); await screenshot('messages-dark-20px-desktop');
    record('GUI-mailbox-is-observation', { messages: expected.length, firstReadReceipts: expected.filter(m => m.firstReadAt).length });
  });
  await stage('narrow-dark-layout', async () => {
    await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
    await selectTask(original.task);
    await page.setViewportSize({ width: 680, height: 900 });
    await geometry('narrow-680-dark-task'); await screenshot('tasks-dark-20px-680');
    await page.setViewportSize({ width: 390, height: 844 });
    await geometry('narrow-390-dark-task'); await screenshot('tasks-dark-20px-390');
    await page.getByRole('button', { name: 'View original conversation', exact: true }).scrollIntoViewIfNeeded();
    const sourceBox = await page.getByRole('button', { name: 'View original conversation', exact: true }).boundingBox();
    assert.ok(sourceBox && sourceBox.y > 0 && sourceBox.y + sourceBox.height < 844, 'Narrow task source remains reachable');
    record('narrow-task-source-remains-reachable');
    await page.getByRole('tab', { name: 'Messages', exact: true }).click();
    await page.locator('.collab-message').first().waitFor();
    await geometry('narrow-390-dark-messages'); await screenshot('messages-dark-20px-390');
    const taskLink = page.getByRole('button', { name: `View task ${original.task.id}`, exact: true }).first();
    await taskLink.scrollIntoViewIfNeeded();
    const taskLinkBox = await taskLink.boundingBox();
    assert.ok(taskLinkBox && taskLinkBox.y > 0 && taskLinkBox.y + taskLinkBox.height < 844, 'Narrow message task link remains reachable');
    await screenshot('messages-dark-20px-390-task-link');
    await taskLink.click();
    await page.getByRole('complementary', { name: 'Task details', exact: true }).waitFor();
    assert.equal(await page.locator('.collab-detail .collab-task-id').innerText(), original.task.id);
    record('narrow-message-task-link-opens-canonical-task', { taskId: original.task.id });
  });
  await stage('narrow-light-and-keyboard', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await appearance('light'); await openBoard(); await selectTask(original.task);
    await page.setViewportSize({ width: 390, height: 844 });
    await geometry('narrow-390-light-task'); await screenshot('tasks-light-20px-390');
    await page.keyboard.press('Escape');
    await until(async () => await page.getByRole('dialog').count() === 0);
    record('Escape-closes-board');
  });
  await stage('no-domain-mutations', async () => {
    const finalTask = await api('task_get', { taskId: original.task.id });
    assert.deepEqual(finalTask.task, original.task);
    // Remote native acceptance may append real comments concurrently. It must
    // not be misreported as a side effect of this read-only browser.
    assert.equal(report.blockedWrites.filter(w => w.path.startsWith('/api/collaboration/')).length, 0);
    assert.equal(report.browserErrors.length, 0, JSON.stringify(report.browserErrors));
    record('no-domain-mutations', { taskVersion: finalTask.task.version, pageErrors: report.browserErrors.length, blockedAutomaticReviews: report.blockedWrites.length });
  });
  }
} catch (error) {
  report.failures.push({ stage: 'setup-or-native-readiness', error: String(error.stack || error) });
  await screenshot('failure-setup').catch(() => {});
} finally {
  await context.close(); await browser.close();
  report.finishedAt = new Date().toISOString();
  const reportPath = resolve(lab, layoutOnly ? 'browser-layout-report.json' : 'browser-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks.length, failures: report.failures.map(f => f.stage), screenshots: report.screenshots, report: reportPath }, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
