// T-88 before any sign-in: what a fresh user sees in the published UI when
// the Core host's Claude Code has an empty profile. One harmless message, no
// tools; nothing is approved. Records what the page and Core say rather than
// assuming it; asserts only what must hold (the same Workspace, nothing sent
// twice, the draft and the outcome kept across a reopen and a Core restart).
// Modes: prelogin, prelogin-reopen. Env: T88_BASE, T88_LAB, T88_PROJECT,
// YUZUNO_BROWSER_BIN.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { api, chromium, composer, composerText, delay, savedDraft, typeDraft, waitConnected } from './ui.mjs';

const mode = process.argv[2];
assert.ok(['prelogin', 'prelogin-reopen'].includes(mode));
const base = process.env.T88_BASE, lab = process.env.T88_LAB, project = process.env.T88_PROJECT;
assert.ok(base && lab && project && process.env.YUZUNO_BROWSER_BIN);
const statePath = resolve(lab, 'pre-login-state.json');
const state = mode === 'prelogin'
  ? { name: 'T88 before sign-in', prompt: 'Reply with exactly PRELOGIN_OK. Do not use any tools.', draft: 'Draft before sign-in: 中文 and English stay.' }
  : JSON.parse(await readFile(statePath, 'utf8'));
const report = { mode, startedAt: new Date().toISOString(), checks: [], observed: {}, pageErrors: [], passed: false };
const check = (name, ok, data = {}) => {
  report.checks.push({ name, ok: !!ok, ...data });
  console.log(ok ? 'PASS' : 'FAIL', name);
  assert.ok(ok, name);
};
const observe = (key, value) => {
  report.observed[key] = value;
  console.log('OBSERVED', key, JSON.stringify(value).slice(0, 400));
};
const context = await chromium.launchPersistentContext(resolve(lab, 'pre-login-profile'), {
  executablePath: process.env.YUZUNO_BROWSER_BIN, headless: true,
  viewport: { width: 1440, height: 960 }, args: ['--disable-dev-shm-usage'],
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(45000);
page.on('pageerror', error => report.pageErrors.push(error.message));
await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
// What the conversation shows for its latest turn, as a person reads it.
const visible = () => page.locator('main').first().innerText().then(text => text.slice(-1500)).catch(() => null);

try {
  await page.goto(base);
  await waitConnected(page);
  const health = await api(base, '/health');
  check('page reaches the expected Workspace through its own connection',
    (await page.evaluate(() => fetch('/api/health').then(r => r.json()))).workspaceId === health.workspaceId);
  if (mode === 'prelogin') {
    state.workspaceId = health.workspaceId;
    await page.locator('button[aria-label="Create agent"], button.add-agent').first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill(state.name);
    await dialog.getByLabel('Working folder').fill(project);
    await dialog.getByRole('radiogroup', { name: 'Harness', exact: true }).getByRole('radio', { name: 'Claude Code', exact: true }).locator('..').click();
    const models = dialog.getByRole('radiogroup', { name: 'Model', exact: true }).getByRole('radio');
    // Whether the model list loads before any sign-in is itself a finding.
    const end = Date.now() + 90000;
    while (Date.now() < end && !(await models.count())) await delay(500);
    const options = await models.evaluateAll(els => els.map(el => ({ value: el.value, label: el.closest('label')?.innerText || '' })));
    observe('modelOptionsBeforeSignIn', options);
    observe('createDialogText', (await dialog.innerText()).slice(0, 1500));
    const haiku = options.find(o => /haiku/i.test(o.value + ' ' + o.label));
    if (haiku) await dialog.getByRole('radiogroup', { name: 'Model', exact: true }).getByRole('radio', { name: /Haiku/i }).first().locator('..').click();
    await dialog.getByRole('button', { name: 'Create agent', exact: true }).click();
    await page.getByRole('heading', { name: state.name, exact: true }).waitFor({ timeout: 60000 });
    const agent = (await api(base, '/workspace')).agents.find(a => a.name === state.name);
    check('the UI creates a local Claude Agent before any sign-in', !!agent, { agentId: agent?.id, model: agent?.model });
    state.agentId = agent.id;
    observe('agentAfterCreate', { status: agent.status, model: agent.model, connectionState: agent.connectionState ?? null });
    await composer(page, state.name).fill(state.prompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    // Wait for the turn to end or the Agent to report a problem; nothing is retried.
    const stop = Date.now() + 150000;
    let detail;
    while (Date.now() < stop) {
      detail = await api(base, `/agents/${agent.id}`);
      const latest = detail.turns.at(-1);
      if (['error', 'uncertain', 'offline'].includes(detail.agent.status) || (latest && !['pending', 'inProgress'].includes(latest.status))) break;
      await delay(1000);
    }
    await delay(2000);
    detail = await api(base, `/agents/${agent.id}`);
    const latest = detail.turns.at(-1) || null;
    observe('afterSend', {
      agentStatus: detail.agent.status, agentError: detail.agent.error ?? detail.agent.lastError ?? null,
      turns: detail.turns.length, turnStatus: latest?.status ?? null, turnError: latest?.error ?? null,
      items: (latest?.items || []).map(i => ({ type: i.type, text: (i.text || '').slice(0, 300), status: i.status ?? null })),
      pending: detail.pending.length,
    });
    observe('pageTextAfterSend', await visible());
    await page.screenshot({ path: resolve(lab, 'pre-login-after-send.png') });
    check('the message was sent once and nothing waits for an approval', detail.turns.length <= 1 && detail.pending.length === 0,
      { turns: detail.turns.length, pending: detail.pending.length });
    state.turns = detail.turns.length;
    state.turnStatus = latest?.status ?? null;
    state.agentStatus = detail.agent.status;
    await typeDraft(page, state.name, agent.id, state.draft);
    check('an unsent draft is saved', await savedDraft(page, agent.id) === state.draft);
    await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
  } else {
    check('the same Workspace after the Core restart and a new browser process', health.workspaceId === state.workspaceId);
    await page.getByRole('heading', { name: state.name, exact: true }).waitFor();
    await page.getByText(state.prompt, { exact: false }).first().waitFor();
    const detail = await api(base, `/agents/${state.agentId}`);
    observe('afterRestart', { agentStatus: detail.agent.status, turns: detail.turns.length, turnStatus: detail.turns.at(-1)?.status ?? null });
    observe('pageTextAfterRestart', await visible());
    check('the sent message and its outcome are kept, and nothing was sent again',
      detail.turns.length === state.turns && (detail.turns.at(-1)?.status ?? null) === state.turnStatus);
    check('the unsent draft returns to the composer', await composerText(page, state.name) === state.draft);
  }
  check('no browser page errors', report.pageErrors.length === 0, { pageErrors: report.pageErrors });
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await page.screenshot({ path: resolve(lab, `pre-login-${mode}.png`) }).catch(() => {});
  report.finishedAt = new Date().toISOString();
  await context.close();
  await writeFile(resolve(lab, `browser-${mode}.json`), JSON.stringify(report, null, 2) + '\n');
}
