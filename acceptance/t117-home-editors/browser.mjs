// Real isolated Core + built UI. Only the native model transport is a fixture.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from '../../web/node_modules/playwright-core/index.mjs';

const lab = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.match(lab.url, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.notEqual(new URL(lab.url).port, '4317');
const report = { checks: [], errors: [], screenshots: [], scope: 'real isolated Core/UI/MCP; deterministic Codex native transport, no paid model' };
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
let sequence = 0;
async function rpc(agent, method, params = {}) {
  const client = lab.clients[agent];
  const response = await fetch(client.url, { method: 'POST', headers: {
    ...client.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-03-26',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }) });
  assert.ok(response.ok, `${method}: HTTP ${response.status}`);
  const text = await response.text();
  const value = JSON.parse(text.startsWith('data:') || text.startsWith('event:')
    ? text.split('\n').find(line => line.startsWith('data:')).slice(5) : text);
  assert.ok(!value.error, `${method}: ${JSON.stringify(value.error)}`);
  return value.result;
}
async function tool(agent, name, args = {}) {
  return (await rpc(agent, 'tools/call', { name, arguments: args })).structuredContent;
}
async function api(path, init = {}) {
  const response = await fetch(`${lab.url}/api${path}`, { ...init, headers: {
    'X-Yuzuno-Client': 'desktop', 'Content-Type': 'application/json', ...init.headers,
  } });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
const body = text => ({ root: 'body', elements: {
  body: { type: 'BriefBody', props: {}, children: ['text'] }, text: { type: 'Markdown', props: { text } },
} });
const regular = (key, title) => ({ op: 'put', key, kind: 'status', title, body: body(title), status: { asOf: new Date().toISOString(), validFor: 3600 } });
const ask = { op: 'put', key: 'worker/question', kind: 'ask', title: 'Worker question', body: body('An answer from you is needed.'),
  ask: { question: 'Proceed with the fixture?', reply: { freeText: true } } };
async function update(agent, changes) {
  const brief = await tool(agent, 'brief_get');
  return tool(agent, 'brief_update', { requestId: `lab-${++sequence}`, expectedVersion: brief.version,
    ...(changes ? { changes } : { noChange: true }) });
}
const browser = await chromium.launch({ executablePath: process.env.YUZUNO_BROWSER_BIN || '/usr/sbin/chromium',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on('pageerror', error => report.errors.push(error.message));
const seen = [];
page.on('request', request => { if (request.method() === 'POST' && /\/brief\/seen$/.test(request.url())) seen.push(request.postData()); });
const projectPath = `/projects/${encodeURIComponent(lab.project)}/home-editors`;
async function openHome() {
  await page.locator('.toolbar-nav button[title^="Home"]').click();
  await page.locator('.home-panel').waitFor();
}
async function openSettings() {
  await page.locator('.workspace-scope').click();
  await page.getByRole('menuitem', { name: 'Manage projects…' }).click();
  const setting = page.locator('.home-editor-settings');
  await setting.locator('.home-editor-mode input').waitFor();
  return setting;
}
async function closeSettings() {
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
}
async function saveSettings(setting) {
  const response = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(projectPath));
  await setting.getByRole('button', { name: 'Save content editors' }).click();
  assert.equal((await response).status(), 200);
  await page.waitForFunction(() => !document.querySelector('.home-editor-actions')?.textContent.includes('Unsaved changes'));
}
try {
  const initialized = await rpc('worker', 'initialize', { protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 't117-acceptance', version: '1' } });
  assert.match(initialized.instructions, /requiresTurnUpdate is true/);
  assert.match(initialized.instructions, /writeOwnAsk is false.*read-only/);
  const catalog = await rpc('worker', 'tools/list');
  assert.match(catalog.tools.find(tool => tool.name === 'brief_get').description, /Ask-only members have no per-turn obligation/);
  check('real MCP serves the generated conditional permission instructions');
  for (const [id, title] of [['lead', 'Lead summary'], ['ui', 'UI summary'], ['worker', 'Worker old status']]) {
    assert.equal((await update(id, [regular(id, title)])).accepted, true);
  }
  assert.equal((await update('worker', [ask])).accepted, true);
  check('real MCP accepts regular content in unconfigured compatibility mode');
  await page.addInitScript(() => localStorage.setItem('yuzuno.appearance', JSON.stringify({ theme: 'light', fontSize: 20, palette: 'garden' })));
  await page.goto(lab.url);
  await openHome();
  const panel = page.locator(`[data-home-project="${lab.project}"]`);
  let setting = await openSettings();
  await setting.locator('.home-editor-mode input').uncheck();
  await setting.getByLabel('Worker fixture', { exact: true }).uncheck();
  await saveSettings(setting);
  assert.deepEqual((await api(projectPath)).editorAgentIds.sort(), ['lead', 'ui']);
  check('user UI saves selected stable IDs for this project');
  await closeSettings();
  await page.reload();
  await openHome();
  await panel.locator('.home-brief').waitFor();
  const old = page.locator(`#home-section-${lab.project}-worker`);
  const question = page.locator(`#home-section-${lab.project}-worker\\/question`);
  assert.equal(await old.isVisible(), false);
  assert.equal(await panel.locator('.home-team-details').getAttribute('open'), null);
  await page.locator(`[data-needs-you="ask:${lab.project}:worker/question"]`).click();
  await question.waitFor({ state: 'visible' });
  assert.equal(await question.getAttribute('data-home-highlight'), '');
  assert.equal(await old.isVisible(), false);
  assert.equal(seen.length, 0);
  check('revoked old content is hidden without Seen; its Ask subtopic still jumps into view');
  const caps = (await tool('worker', 'brief_get')).you.capabilities;
  assert.equal(caps.editContent, false);
  assert.equal(caps.requiresTurnUpdate, false);
  const refused = await update('worker', [regular('worker', 'Not permitted')]);
  assert.equal(refused.accepted, false);
  assert.equal(refused.problems[0].code, 'ask_only');
  assert.equal((await update('worker')).receipt.kind, 'noChange');
  assert.equal((await update('ui', [regular('ui', 'Updated UI summary')])).accepted, true);
  check('real MCP enforces Ask-only and still accepts editor writes and optional noChange');
  await question.getByRole('textbox', { name: 'Reply to Worker question' }).fill('Proceed in the isolated lab.');
  await question.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.home-ask-replied') || document.body.textContent.includes('Reply again'));
  assert.equal((await tool('worker', 'brief_get')).sections.find(section => section.key === ask.key).ask.state, 'replied');
  assert.equal((await update('worker', [{ op: 'resolve', key: ask.key }])).accepted, true);
  check('Ask-only owner receives a Home answer and resolves the Ask through MCP');
  await panel.locator('.home-team-details > summary').click();
  await old.waitFor({ state: 'visible' });
  assert.match(await old.textContent(), /Worker old status/);
  assert.equal(seen.length, 0);
  check('explicit team details retains the original unread content');
  setting = await openSettings();
  for (const name of ['Lead fixture', 'UI fixture']) await setting.getByLabel(name, { exact: true }).uncheck();
  await saveSettings(setting);
  assert.deepEqual((await api(projectPath)).editorAgentIds, []);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    assert.equal(await setting.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
    const shot = `editors-${theme}-20px.png`;
    await page.screenshot({ path: `${lab.output}/${shot}` });
    report.screenshots.push(shot);
  }
  await closeSettings();
  await page.reload();
  await openHome();
  const data = await api('/home');
  const current = data.projects.find(project => project.project.id === lab.project);
  assert.equal(current.unseen, 0);
  assert.equal(current.brief.sections.length, 0);
  assert.equal(current.brief.teamSections.length, 3);
  assert.ok(data.needsYou.some(item => item.requestId === 'approval-lab'));
  await page.locator('[data-needs-you="approval:approval-lab"]').click();
  await page.locator('#home-request-approval-lab').waitFor({ state: 'visible' });
  assert.equal(seen.length, 0);
  check('explicit empty list persists through reload and native approval remains reachable');
  check('light/dark editor layouts at configured 20px have no horizontal overflow');
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = error.stack || String(error);
  await page.screenshot({ path: `${lab.output}/failure.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(`${lab.output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  if (report.failure) console.error(report.failure);
}
