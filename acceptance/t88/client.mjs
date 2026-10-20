// T-88 lab A browser client, run by install-lab.py against its installed
// Core. One persistent profile plays one person's browser across steps:
//   first      create a Claude Agent in the UI; one turn writes a file after
//              "Allow once" in the page; leave a draft; close the browser.
//   reopen     the same profile again: history and the draft are there.
//   send-draft after the update: history and draft kept; send the draft.
// Env: T88_BASE, T88_LAB, T88_PROJECT. Writes <lab>/client-<mode>.json.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { answerText, chromium, composerText, createClaudeAgent, savedDraft, sendAndFinish, turnsOf, typeDraft, waitConnected } from './ui.mjs';

const mode = process.argv[2];
assert.ok(['first', 'reopen', 'send-draft'].includes(mode));
const base = process.env.T88_BASE, lab = process.env.T88_LAB, project = process.env.T88_PROJECT;
assert.ok(base && lab && project);
const statePath = resolve(lab, 'client-state.json');
const state = mode === 'first' ? { name: 'T-88 first agent', draft: 'Reply with the single word kept.' } : JSON.parse(await readFile(statePath, 'utf8'));
const report = { mode, startedAt: new Date().toISOString(), checks: [], pageErrors: [], passed: false };
const check = (name, ok, data = {}) => {
  report.checks.push({ name, ok: !!ok, ...data });
  console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(data).slice(0, 400));
  assert.ok(ok, name);
};

const context = await chromium.launchPersistentContext(resolve(lab, 'browser-profile'), {
  executablePath: process.env.YUZUNO_BROWSER_BIN || '/usr/sbin/chromium', headless: true, viewport: { width: 1440, height: 960 },
  args: ['--disable-dev-shm-usage'],
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(60000);
page.on('pageerror', error => report.pageErrors.push(error.message));
// Only this Core: an installed release must not need anything else.
await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
try {
  await page.goto(base);
  await waitConnected(page);
  report.release = await page.locator('meta[name="yuzuno-release"]').getAttribute('content');
  if (mode === 'first') {
    const agent = await createClaudeAgent(page, base, { name: state.name, cwd: project });
    Object.assign(state, { agentId: agent.id, model: agent.model.value });
    check('a Claude Agent is created in the UI with a Haiku model', true, { agentId: agent.id, model: agent.model });
    await page.getByRole('textbox', { name: `Message ${state.name}`, exact: true })
      .fill('Use the Write tool to create a file named t88.txt containing the word ok, then reply with the single word done.');
    const { turn, approvals } = await sendAndFinish(page, base, agent.id, { approve: true });
    const written = await readFile(resolve(project, 't88.txt'), 'utf8').catch(() => null);
    check('the first turn asks for approval in the page, and the approved write completes',
      turn.status === 'completed' && approvals >= 1 && written?.trim() === 'ok', { status: turn.status, approvals, written: written?.trim() });
    state.firstAnswer = answerText(turn).trim();
    await page.getByText(state.firstAnswer, { exact: false }).last().waitFor();
    check('the answer is shown in the conversation', !!state.firstAnswer, { answer: state.firstAnswer.slice(0, 80) });
    await typeDraft(page, state.name, agent.id, state.draft);
    check('an unsent draft is saved in this browser', (await savedDraft(page, agent.id)) === state.draft);
    await writeFile(statePath, JSON.stringify(state, null, 2));
    await page.screenshot({ path: resolve(lab, 'client-first.png') });
  } else {
    await page.getByRole('heading', { name: state.name, exact: true }).waitFor();
    await page.getByText('create a file named t88.txt', { exact: false }).first().waitFor();
    await page.getByText(state.firstAnswer, { exact: false }).last().waitFor();
    check('history shows the first request and answer', true);
    check('the draft is back in the composer', (await composerText(page, state.name)) === state.draft,
      { composer: await composerText(page, state.name) });
    await page.screenshot({ path: resolve(lab, `client-${mode}.png`) });
    if (mode === 'send-draft') {
      const before = (await turnsOf(base, state.agentId)).length;
      const { turn } = await sendAndFinish(page, base, state.agentId);
      const detail = (await turnsOf(base, state.agentId));
      check('the draft is sent after the update and Claude answers in the same Agent',
        turn.status === 'completed' && detail.length === before + 1 && /kept/i.test(answerText(turn)),
        { status: turn.status, answer: answerText(turn).slice(0, 80), turns: detail.length });
      check('the sent draft is cleared', (await savedDraft(page, state.agentId)) === '');
    }
  }
  report.passed = true;
} finally {
  report.finishedAt = new Date().toISOString();
  await context.close();
  await writeFile(resolve(lab, `client-${mode}.json`), JSON.stringify(report, null, 2) + '\n');
}
