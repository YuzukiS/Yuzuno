// Explicit, isolated GUI mutation acceptance. Creates one unassigned test task,
// never messages an Agent, and archives only that task when finished.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lab = dirname(fileURLToPath(import.meta.url));
const base = 'http://127.0.0.1:4379';
const screenshots = resolve(lab, 'screenshots');
const { chromium } = await import(pathToFileURL(resolve(lab, '../../web/node_modules/playwright-core/index.mjs')));
const runId = randomUUID().slice(0, 8);
const title = `GUI acceptance ${runId} · Preserve a task draft during concurrent editing`;
const description = 'The same task should retain a local draft, compare concurrent changes, and preserve unrelated fields.';
const localDescription = 'My draft: compare the latest shared description before applying only my changed fields.';
const externalDescription = 'Concurrent editor: the shared description changed while the GUI draft was open.';
const externalProgress = 'Concurrent editor verified the source links; this progress must survive the GUI save.';
const report = {
  startedAt: new Date().toISOString(), runId, title, checks: [], failures: [],
  screenshots: [], requests: [], blockedRequests: [], browserErrors: [],
};
const reads = new Set(['task_list', 'task_get', 'peer_read', 'peers_list']);
const guiWrites = new Set(['task_create', 'task_update', 'task_comment', 'task_submit_result']);
let taskId;
let nativeBefore;
let browser;
let page;
const pause = ms => new Promise(done => setTimeout(done, ms));
const record = (name, detail = {}) => {
  report.checks.push({ name, ...detail });
  console.log(JSON.stringify({ check: name, ...detail }));
};
async function api(operation, input = {}) {
  const isRead = reads.has(operation);
  assert.ok(isRead || (operation === 'task_update' && taskId && input.taskId === taskId), 'Direct API writes are restricted to the new acceptance task');
  const body = isRead ? input : { ...input, requestId: randomUUID() };
  const response = await fetch(`${base}/api/collaboration/${operation}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Yuzuno-Client': 'desktop' }, body: JSON.stringify(body),
  });
  assert.ok(response.ok, `${operation}: ${await response.clone().text()}`);
  return response.json();
}
const current = () => api('task_get', { taskId });
async function until(check, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(100); }
  throw Error('GUI acceptance condition timed out');
}
async function screenshot(name) {
  const path = resolve(screenshots, `write-${name}.png`);
  await page.screenshot({ path }); report.screenshots.push(path);
  console.log(JSON.stringify({ screenshot: path }));
}
async function submit(operation, action, expectedSuccess = true) {
  const responsePromise = page.waitForResponse(response => response.url() === `${base}/api/collaboration/${operation}` && response.request().method() === 'POST');
  await action();
  const response = await responsePromise;
  const value = await response.json();
  if (operation === 'task_create' && value.task?.id) {
    taskId = value.task.id; report.taskId = taskId;
  }
  assert.equal(response.ok(), expectedSuccess, `${operation}: ${JSON.stringify(value)}`);
  return value;
}
try {
  const manifest = JSON.parse(await readFile(resolve(lab, 'native-state.json'), 'utf8'));
  assert.ok(manifest.checks?.length, 'Run after the real native collaboration checks complete');
  nativeBefore = (await api('task_get', { taskId: manifest.taskId })).task;
  await mkdir(screenshots, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: '/usr/sbin/chromium', args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.addInitScript(() => localStorage.setItem('yuzuno.appearance', JSON.stringify({ theme: 'light', fontSize: 20 })));
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== base) return route.abort();
    if (['GET', 'HEAD'].includes(request.method())) return route.continue();
    const operation = url.pathname.match(/^\/api\/collaboration\/([^/]+)$/)?.[1];
    const input = request.postDataJSON() || {};
    if (request.method() === 'POST' && reads.has(operation)) return route.continue();
    const ownCreate = operation === 'task_create' && !taskId && input.title === title && !input.assigneeAgentId;
    const ownMutation = operation !== 'task_create' && guiWrites.has(operation) && taskId && input.taskId === taskId;
    if (request.method() === 'POST' && (ownCreate || ownMutation)) {
      report.requests.push({ operation, body: input }); return route.continue();
    }
    report.blockedRequests.push({ method: request.method(), path: url.pathname });
    return route.abort();
  });
  page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', error => report.browserErrors.push(error.message));
  await page.goto(base + '/?shell=desktop');
  await page.getByRole('button', { name: 'Tasks & messages', exact: true }).click();
  await page.getByRole('dialog', { name: 'A place to work together' }).waitFor();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const newTask = page.getByRole('complementary', { name: 'New task', exact: true });
  await newTask.getByLabel('Task title', { exact: true }).fill(title);
  assert.equal(await newTask.getByRole('button', { name: 'Create task', exact: true }).isEnabled(), true);
  const created = await submit('task_create', () => newTask.getByRole('button', { name: 'Create task', exact: true }).click());
  assert.equal(created.task.status, 'todo'); assert.equal(created.task.description, ''); assert.equal(created.task.assigneeAgentId, null);
  assert.equal(created.task.version, 1);
  assert.match(created.task.id, /^T-[1-9]\d*$/);
  record('GUI-create-only-title-required', { taskId });
  const pane = page.getByRole('complementary', { name: 'Task details', exact: true });
  await pane.locator('.collab-task-id').waitFor();
  assert.equal(await pane.locator('.collab-task-id').innerText(), taskId);
  assert.equal(await page.locator(`.collab-task-card[data-task-id="${taskId}"] .collab-task-id`).innerText(), taskId);
  await pane.getByRole('button', { name: 'Edit task', exact: true }).click();
  await pane.getByLabel(/^Description/).fill(description);
  await pane.getByLabel('Task status').selectOption('doing');
  await pane.getByLabel(/^Latest progress/).fill('The GUI editing flow is ready to inspect.');
  const edited = await submit('task_update', () => pane.getByRole('button', { name: 'Save changes', exact: true }).click());
  assert.equal(edited.task.description, description); assert.equal(edited.task.status, 'doing'); assert.equal(edited.task.version, 2);
  record('GUI-edit-definition-and-progress');

  const note = `Acceptance note ${runId}: a comment must preserve the task's semantic version.`;
  await pane.getByLabel(/^Add a note/).fill(note);
  const commented = await submit('task_comment', () => pane.getByRole('button', { name: 'Add note', exact: true }).click());
  assert.equal(commented.task.version, 2);
  await until(async () => (await pane.locator('.collab-activity').innerText()).includes(note));
  assert.equal(await pane.getByLabel(/^Add a note/).inputValue(), '');
  record('GUI-comment-appends-without-consuming-version');

  await pane.getByRole('button', { name: 'Edit task', exact: true }).click();
  await pane.getByLabel(/^Description/).fill(localDescription);
  const concurrent = await api('task_update', { taskId, expectedVersion: 2, patch: { description: externalDescription, progress: externalProgress } });
  assert.equal(concurrent.task.version, 3);
  // Explicit refresh works even if the independent SSE update has already won.
  await pane.getByRole('button', { name: 'Refresh task details', exact: true }).click();
  await pane.locator('.collab-conflict').waitFor();
  assert.equal(await pane.getByLabel(/^Description/).inputValue(), localDescription);
  const rejected = await submit('task_update', () => pane.getByRole('button', { name: 'Save changes', exact: true }).click(), false);
  assert.ok(JSON.stringify(rejected).includes('version_conflict'));
  assert.equal(await pane.getByLabel(/^Description/).inputValue(), localDescription);
  const stillConcurrent = await current();
  assert.equal(stillConcurrent.task.description, externalDescription); assert.equal(stillConcurrent.task.version, 3);
  await pane.getByText('Compare with the current task', { exact: true }).click();
  assert.ok((await pane.locator('.collab-conflict').innerText()).includes(externalDescription));
  await screenshot('conflict-comparison-draft-preserved');
  record('GUI-stale-save-rejected-and-draft-preserved');
  await pane.getByRole('button', { name: 'Keep my changed fields on this version', exact: true }).click();
  const reapplied = await submit('task_update', () => pane.getByRole('button', { name: 'Save changes', exact: true }).click());
  assert.equal(reapplied.task.version, 4);
  assert.equal(reapplied.task.description, localDescription);
  assert.equal(reapplied.task.progress, externalProgress, 'Unchanged draft fields must not overwrite concurrent progress');
  const updateRequests = report.requests.filter(r => r.operation === 'task_update');
  assert.deepEqual(Object.keys(updateRequests.at(-1).body.patch), ['description']);
  record('GUI-explicit-apply-preserves-unrelated-concurrent-fields');

  await pane.getByRole('button', { name: 'Add result', exact: true }).click();
  const reviewSummary = 'The local draft survived a conflicting save; applying it retained the other editor’s progress.';
  await pane.getByLabel(/^Result summary/).fill(reviewSummary);
  const resultStatus = pane.getByLabel('After adding this result');
  const statusOptions = await resultStatus.locator('option').evaluateAll(options => options.map(option => option.value));
  assert.deepEqual(statusOptions.sort(), ['done', 'review'], 'GUI must only offer result states supported by Store');
  await resultStatus.selectOption('review');
  await pane.getByRole('button', { name: 'Add a web link', exact: true }).click();
  await pane.getByLabel('Link label', { exact: true }).fill('Task-board design reference');
  await pane.getByLabel('Web address', { exact: true }).fill('https://linear.app/docs/creating-issues');
  const reviewed = await submit('task_submit_result', () => pane.getByRole('button', { name: 'Save result', exact: true }).click());
  assert.equal(reviewed.task.status, 'review'); assert.equal(reviewed.task.version, 5);
  assert.equal(reviewed.task.result.reportedBy.kind, 'user'); assert.equal(reviewed.task.result.source, null);
  assert.equal(reviewed.task.result.summary, reviewSummary);
  await pane.locator('.collab-result-links a').waitFor();
  assert.equal(await pane.locator('.collab-result-links a').getAttribute('rel'), 'noopener noreferrer');
  await screenshot('result-ready-for-review');
  record('GUI-submit-review-result-with-a-safe-link');

  await pane.getByRole('button', { name: 'Update result', exact: true }).click();
  const doneSummary = 'Verified the create, edit, discussion, review, completion, and conflict-resolution flows in the isolated GUI.';
  await pane.getByLabel(/^Result summary/).fill(doneSummary);
  await pane.getByLabel('After adding this result').selectOption('done');
  const done = await submit('task_submit_result', () => pane.getByRole('button', { name: 'Save result', exact: true }).click());
  assert.equal(done.task.status, 'done'); assert.equal(done.task.version, 6);
  assert.equal(done.task.result.summary, doneSummary);
  const finished = await current();
  assert.equal(finished.activities.filter(a => a.kind === 'comment').length, 1);
  assert.equal(finished.activities.filter(a => a.kind === 'result').length, 2);
  assert.deepEqual(finished.executions, [], 'GUI-only work must not invent a native execution');
  assert.equal(finished.task.assigneeAgentId, null);
  await screenshot('result-done');
  record('GUI-submit-done-result-on-the-same-task');
  const linkedMessages = (await api('peer_read', { limit: 200 })).messages.filter(m => m.taskId === taskId);
  assert.deepEqual(linkedMessages, []);
  assert.equal(report.blockedRequests.filter(r => r.path.startsWith('/api/collaboration/')).length, 0);
  assert.equal(report.browserErrors.length, 0);
  assert.deepEqual((await api('task_get', { taskId: manifest.taskId })).task, nativeBefore);
  record('no-Agent-work-or-peer-messages-and-real-native-task-intact');
} catch (error) {
  report.failures.push(String(error.stack || error));
  if (page) await screenshot('failure').catch(() => {});
} finally {
  if (taskId) {
    try {
      const latest = await current();
      const archived = latest.task.archivedAt ? latest : await api('task_update', { taskId, expectedVersion: latest.task.version, patch: { archived: true } });
      assert.ok(archived.task.archivedAt);
      const retained = await current();
      report.finalTask = retained.task;
      report.activityCount = retained.activities.length;
      assert.ok(!(await api('task_list', { limit: 200 })).tasks.some(task => task.id === taskId));
      record('acceptance-task-archived-and-history-retained', { taskId, version: retained.task.version });
    } catch (error) { report.failures.push(`Cleanup: ${error.stack || error}`); }
  }
  if (browser) await browser.close();
  report.finishedAt = new Date().toISOString();
  const reportPath = resolve(lab, 'browser-write-report.json');
  await writeFile(resolve(lab, `browser-write-report-${runId}.json`), JSON.stringify(report, null, 2));
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ taskId, checks: report.checks.length, failures: report.failures, report: reportPath, screenshots: report.screenshots }, null, 2));
  if (report.failures.length) process.exitCode = 1;
}
