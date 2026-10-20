// T-88 browser steps shared by the install and tunnel labs. Every action goes
// through the page as a person would; the API is read only to wait for and
// confirm what the page did.
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const { chromium } = await import(pathToFileURL(resolve(repo, 'web/node_modules/playwright-core/index.mjs')));
export const delay = ms => new Promise(done => setTimeout(done, ms));

export async function api(base, path, body) {
  const response = await fetch(base + '/api' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-yuzuno-client': 'desktop' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

export async function until(fn, timeout, label) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await delay(500);
  }
  throw Error(`Timed out: ${label}`);
}

export const coreStatus = page => page.locator('.connection[data-core-status]').first().getAttribute('data-core-status');
export const waitConnected = (page, timeout = 60000) =>
  page.locator('.connection[data-core-status="Core connected"]').first().waitFor({ timeout });

// core.6 has an icon button named "Create agent"; later UIs a "New agent" row.
export async function createClaudeAgent(page, base, { name, cwd }) {
  await page.locator('button[aria-label="Create agent"], button.add-agent').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Working folder').fill(cwd);
  await dialog.getByLabel('Harness').selectOption('claude');
  const model = dialog.getByLabel('Model');
  // The cheapest model only: never fall back to the harness default.
  const haiku = await until(async () => {
    if (await model.isDisabled()) return null;
    const options = await model.locator('option').evaluateAll(els => els.map(o => ({ value: o.value, text: o.textContent })));
    return options.find(o => /haiku/i.test(o.value + ' ' + o.text)) || null;
  }, 90000, 'a Haiku model in the Claude model list');
  await model.selectOption(haiku.value);
  await dialog.getByRole('button', { name: 'Create agent', exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor({ timeout: 60000 });
  const agent = (await api(base, '/workspace')).agents.find(a => a.name === name);
  assert.ok(agent, 'the created Agent is in the Workspace');
  return { id: agent.id, model: haiku };
}

export const composer = (page, name) => page.getByRole('textbox', { name: `Message ${name}`, exact: true });
export const composerText = (page, name) => composer(page, name).evaluate(el => el.innerText.replace(/\n$/, ''));
export const savedDraft = (page, agentId) => page.evaluate(id => {
  const draft = JSON.parse(localStorage.getItem('yuzuno.composer.v1:' + id) || '{"parts":[]}');
  return draft.parts.map(p => p.kind === 'text' ? p.text : '').join('');
}, agentId);

export async function typeDraft(page, name, agentId, text) {
  await composer(page, name).fill(text);
  await page.waitForFunction(({ id, text }) =>
    (localStorage.getItem('yuzuno.composer.v1:' + id) || '').includes(text), { id: agentId, text });
}

export const turnsOf = async (base, agentId) => (await api(base, `/agents/${agentId}`)).turns;

// Sends what the composer holds and waits for that turn to finish, clicking
// "Allow once" in the page for every permission Claude asks for.
export async function sendAndFinish(page, base, agentId, { approve = false, timeout = 240000 } = {}) {
  const before = (await turnsOf(base, agentId)).length;
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  let approvals = 0;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const detail = await api(base, `/agents/${agentId}`);
    const turn = detail.turns[before];
    if (turn && !['inProgress', 'pending'].includes(turn.status)) return { turn, approvals, detail };
    const allow = page.getByRole('button', { name: 'Allow once', exact: true });
    if (await allow.first().isVisible().catch(() => false)) {
      assert.ok(approve, 'Claude asked for a permission this step did not expect');
      await allow.first().click();
      approvals += 1;
      await delay(1500);
    }
    if (['error', 'uncertain'].includes(detail.agent.status)) throw Error(`Agent ${detail.agent.status}: ${detail.agent.error || ''}`);
    await delay(700);
  }
  throw Error('Timed out waiting for the turn; nothing was retried');
}

export const answerText = turn =>
  (turn.items || []).filter(i => i.type === 'agentMessage').map(i => i.text || '').join('\n');
