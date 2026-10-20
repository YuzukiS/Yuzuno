// Current published UI: one real, harmless command/approval, saved settings,
// then two separate browser processes. Never auto-approve arbitrary actions.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { answerText, api, chromium, composer, composerText, delay, savedDraft, turnsOf, typeDraft, waitConnected } from './ui.mjs';

const mode = process.argv[2];
assert.ok(['first', 'reopen', 'restart', 'offline', 'offline-reload', 'restored'].includes(mode));
const base = process.env.T88_BASE, lab = process.env.T88_LAB, project = process.env.T88_PROJECT;
const apiBase = process.env.T88_API_BASE || base;
assert.ok(base && lab && project && (process.env.YUZUNO_BROWSER_BIN || process.env.T88_CDP));
const command = `python3 -I -c 'print("T88_APPROVED")'`;
const statePath = resolve(lab, 'first-use-state.json');
const state = mode === 'first' ? {
  name: 'T88 first use', draft: 'Unsent draft: 中文 and English remain here.',
  prompt: `Run exactly this Bash command once: ${command}\nDo not read or write files, use other tools, or change the command. After it succeeds, reply with FIRST_USE_OK.`,
} : JSON.parse(await readFile(statePath, 'utf8'));
const report = { mode, startedAt: new Date().toISOString(), checks: [], pageErrors: [], passed: false };
const check = (name, ok, data = {}) => {
  report.checks.push({ name, ok: !!ok, ...data });
  console.log(ok ? 'PASS' : 'FAIL', name);
  assert.ok(ok, name);
};
async function until(fn, timeout, label) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn(); // Permission assertion failures must stop immediately.
    if (value) return value;
    await delay(500);
  }
  throw Error(`Timed out: ${label}; no retry was sent`);
}
const remoteBrowser = process.env.T88_CDP ? await chromium.connectOverCDP(process.env.T88_CDP) : null;
const context = remoteBrowser ? remoteBrowser.contexts()[0] : await chromium.launchPersistentContext(resolve(lab, 'first-use-profile'), {
  executablePath: process.env.YUZUNO_BROWSER_BIN, headless: true,
  viewport: { width: 1440, height: 960 }, args: ['--disable-dev-shm-usage'],
});
const page = context.pages()[0] || await context.newPage();
page.setDefaultTimeout(45000);
page.on('pageerror', error => report.pageErrors.push(error.message));
await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());

async function settingsDialog() {
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
  return page.getByRole('dialog', { name: state.name + ' · Agent settings', exact: true });
}

try {
  if (mode === 'offline' || mode === 'offline-reload') {
    assert.ok(remoteBrowser, 'Offline modes require the same remote browser process');
    await page.locator('.connection[data-core-status="Core unreachable"]').first().waitFor({ timeout: 60000 });
    check('tunnel loss pauses sending and retains visible and saved draft',
      await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled()
      && await composerText(page, state.name) === state.draft && await savedDraft(page, state.agentId) === state.draft);
    if (mode === 'offline-reload') {
      const failed = await page.reload().then(() => false, error => /ERR_(CONNECTION|EMPTY_RESPONSE|SOCKET)/.test(error.message));
      check('reload without tunnel fails without creating a Workspace', failed);
    }
    report.passed = true;
  } else {
    // restored deliberately keeps the already-open page to exercise automatic
    // reconnection; the other modes perform a genuine navigation/reopen.
    if (mode !== 'restored') await page.goto(base);
    await waitConnected(page);
    const health = await api(apiBase, '/health');
    check('page reaches the expected Workspace through its own connection',
      (await page.evaluate(() => fetch('/api/health').then(r => r.json()))).workspaceId === health.workspaceId);
    if (remoteBrowser) {
      const platform = await page.evaluate(() => navigator.platform);
      check('browser runs on the Mac client', platform === 'MacIntel' || platform.startsWith('Mac'), { platform });
    }
    if (mode === 'first') {
      state.workspaceId = health.workspaceId;
      await page.locator('button[aria-label="Create agent"], button.add-agent').first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Name', { exact: true }).fill(state.name);
      await dialog.getByLabel('Working folder').fill(project);
      await dialog.getByRole('radiogroup', { name: 'Harness', exact: true }).getByRole('radio', { name: 'Claude Code', exact: true }).locator('..').click();
      // The list may offer more than one Haiku (core.11 lists Haiku 5.5 and 4.5): the first one, recorded below.
      const haiku = dialog.getByRole('radiogroup', { name: 'Model', exact: true }).getByRole('radio', { name: /Haiku/i }).first();
      await haiku.waitFor({ state: 'attached', timeout: 90000 });
      await haiku.locator('..').click();
      state.model = await haiku.inputValue();
      await dialog.getByRole('button', { name: 'Create agent', exact: true }).click();
      await page.getByRole('heading', { name: state.name, exact: true }).waitFor();
      const agent = (await api(apiBase, '/workspace')).agents.find(a => a.name === state.name);
      assert.ok(agent);
      state.agentId = agent.id;
      check('UI creates local Claude Agent with explicit Haiku model', agent.model === state.model && /haiku/i.test(state.model), { agentId: agent.id, model: state.model });
      const settings = await settingsDialog();
      await settings.getByRole('radio', { name: 'Ask before actions', exact: true }).locator('..').click();
      await settings.getByRole('button', { name: 'Save', exact: true }).click();
      await settings.waitFor({ state: 'hidden' });
      check('UI saves Agent model and approval configuration',
        (await api(apiBase, `/agents/${agent.id}`)).agent.settings.permissionMode === 'default');
      await composer(page, state.name).fill(state.prompt);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      let approvals = 0;
      const approved = new Set();
      const turn = await until(async () => {
        const detail = await api(apiBase, `/agents/${agent.id}`);
        for (const pending of detail.pending.filter(p => !p.stale && !p.params._responseSent)) {
          if (approved.has(pending.id)) continue;
          // Abort on anything other than the sole read-only command requested.
          assert.equal(pending.method, 'claude/canUseTool');
          assert.equal(pending.params.toolName, 'Bash');
          assert.equal(pending.params.input.command, command);
          assert.ok(!pending.params.input.run_in_background);
          assert.equal(approvals, 0, 'Do not approve repeated execution');
          await page.locator(`[id="request-${pending.id}"]`).getByRole('button', { name: 'Allow once', exact: true }).click();
          approved.add(pending.id);
          approvals += 1;
        }
        assert.ok(!['error', 'uncertain'].includes(detail.agent.status), 'Native Agent failed');
        const latest = detail.turns.at(-1);
        return latest && !['pending', 'inProgress'].includes(latest.status) ? latest : null;
      }, 180000, 'one native turn with one approval');
      check('one real turn completed after exactly one harmless approval', turn.status === 'completed' && approvals === 1,
        { status: turn.status, approvals, turnId: turn.id });
      const actions = turn.items.filter(item => item.type === 'claudeToolUse');
      check('the sole native command completed and returned its marker', actions.length === 1
        && actions[0].name === 'Bash' && actions[0].input.command === command
        && actions[0].status === 'completed' && actions[0].output.trim() === 'T88_APPROVED');
      state.turnId = turn.id;
      state.firstAnswer = answerText(turn).trim();
      check('native final answer contains the requested marker', state.firstAnswer.includes('FIRST_USE_OK'));
      await page.locator('.final-message').filter({ hasText: 'FIRST_USE_OK' }).waitFor();
      await typeDraft(page, state.name, agent.id, state.draft);
      check('unsent draft is saved', await savedDraft(page, agent.id) === state.draft);
      await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
    } else {
      check('same Workspace after reopening', health.workspaceId === state.workspaceId);
      await page.getByRole('heading', { name: state.name, exact: true }).waitFor();
      await page.getByText(state.prompt, { exact: false }).first().waitFor();
      await page.locator('.final-message').filter({ hasText: 'FIRST_USE_OK' }).waitFor();
      const turns = await turnsOf(apiBase, state.agentId);
      check('same completed turn and native answer retained', turns.length === 1 && turns[0].id === state.turnId && answerText(turns[0]).trim() === state.firstAnswer);
      check('unsent draft returns to composer', await composerText(page, state.name) === state.draft);
      const settings = await settingsDialog();
      const selected = settings.getByRole('radiogroup', { name: 'Model', exact: true }).locator('input:checked');
      await until(async () => await selected.inputValue() === state.model, 30000, 'saved model');
      check('model and permission choices are retained in UI', await selected.inputValue() === state.model
        && await settings.getByRole('radio', { name: 'Ask before actions', exact: true }).isChecked());
      await page.keyboard.press('Escape');
    }
    check('no browser page errors', report.pageErrors.length === 0);
    report.passed = true;
  }
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await page.screenshot({ path: resolve(lab, `first-use-${mode}.png`) }).catch(() => {});
  report.finishedAt = new Date().toISOString();
  // Closing a CDP attachment disconnects this controller. The Mac owner
  // controls the browser process and its persistent profile across modes.
  if (remoteBrowser) await remoteBrowser.close();
  else await context.close();
  await writeFile(resolve(lab, `browser-${mode}.json`), JSON.stringify(report, null, 2) + '\n');
}
