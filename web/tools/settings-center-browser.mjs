// Built application in isolated Chromium. Every request is fulfilled by synthetic
// fixtures; neither a daily Core nor real localStorage is a test input.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { chromium } from "playwright-core";
import { unmanagedUpdates, noJobs, noCiRuns, noReviews, noLiveJobs } from "./browser-fixtures.mjs";
assert.ok(process.env.YUZUNO_UI_DIST && process.env.YUZUNO_BROWSER_OUTPUT, "Explicit isolated assets/output required");
const dist = resolve(process.env.YUZUNO_UI_DIST), output = resolve(process.env.YUZUNO_BROWSER_OUTPUT);
assert.ok(!dist.endsWith('/web/dist'), 'Use a separate build');
await mkdir(output, { recursive: true });
const origin = "http://settings-fixture.test";
const base = { cwd: "/fixture/garden", threadId: "fixture-thread", connectionState: "connected", status: "idle", model: "fixture-model", color: "sage", createdAt: "", updatedAt: "", unreadCount: 0, pendingCount: 0, lastSeq: 1, reviewedSeq: 1, settings: {} };
const agents = [
  { ...base, id: "cedar", name: "Cedar", harness: "codex", projectId: "garden" },
  { ...base, id: "pine", name: "Pine", harness: "codex", projectId: "orchard" },
  { ...base, id: "maple", name: "Maple", harness: "claude", projectId: "orchard" },
];
const projects = [
  { id: "garden", name: "Garden", defaultDirs: { local: "/fixture/garden" }, createdAt: "", updatedAt: "" },
  { id: "orchard", name: "Orchard", defaultDirs: { local: "/fixture/orchard" }, createdAt: "", updatedAt: "" },
];
const budget = { machine: { name: "Fixture Core", logicalCpus: 8, memoryTotalMiB: 16384, memoryAvailableMiB: 12000, scope: "Managed Jobs only" }, budget: { cpuMillis: 2000, memoryMiB: 4096, swapMiB: 0 }, reserved: { cpuMillis: 0, memoryMiB: 0, swapMiB: 0 }, activeCount: 0, queuedCount: 0 };
const calls = [], errors = [], checks = [];
const browser = await chromium.launch({ headless: true, executablePath: process.env.YUZUNO_BROWSER_BIN || "/usr/bin/chromium" });
const context = await browser.newContext({ viewport: { width: 1360, height: 960 } });
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error' && /TypeError|ReferenceError|Minified React error/.test(message.text())) errors.push(message.text()); });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
await context.addInitScript(() => {
  localStorage.setItem('yuzuno.selected', JSON.stringify('cedar'));
  localStorage.setItem('yuzuno.composer.v1:cedar', JSON.stringify({ version: 1, parts: [{ kind: 'text', text: 'Keep this draft' }] }));
});
await context.route('**/*', async (route) => {
  const request = route.request(), url = new URL(request.url());
  assert.equal(url.origin, origin, 'No real or third-party services');
  if (!url.pathname.startsWith('/api/')) {
    const path = resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    assert.ok(path.startsWith(dist + '/'));
    try { return await route.fulfill({ body: await readFile(path), contentType: mime[extname(path)] || 'application/octet-stream' }); }
    catch { return route.fulfill({ status: 404, body: '' }); }
  }
  calls.push({ path: url.pathname, method: request.method() });
  const respond = (value) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  const agent = agents.find((a) => url.pathname === `/api/agents/${a.id}`);
  if (agent) return respond({ agent, turns: [{ id: `turn-${agent.id}`, status: 'completed', items: [{ id: `reply-${agent.id}`, type: 'agentMessage', text: 'Synthetic conversation' }] }], pending: [], artifacts: [], messageReceipts: [] });
  if (/\/agents\/[^/]+\/models$/.test(url.pathname)) return respond({ models: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture model', supportedReasoningEfforts: [] }], context: { supported: true, settingsSubmitted: false, canApply: false, observedWindowTokens: null } });
  if (/\/projects\/[^/]+\/services$/.test(url.pathname)) return respond({ services: [] });
  if (/\/projects\/[^/]+\/home-editors$/.test(url.pathname)) return respond({ version: 0, editorAgentIds: null });
  if (url.pathname === '/api/collaboration/github_repositories') return respond({ links: [], repositories: [], refreshing: false });
  if (/\/claude\/auto-continue$/.test(url.pathname)) return respond({ workspace: true, agent: null, enabled: true, intent: null, stopped: null });
  switch (url.pathname) {
    case '/api/health': return respond({ product: 'yuzuno', application: 'yuzuno-next', workspaceId: 'settings-fixture', releaseId: 'fixture' });
    case '/api/workspace': return respond({ agents, projects, projectUsage: {}, runtime: { connected: true }, defaultCwd: '/fixture', workspace: { id: 'settings-fixture' } });
    case '/api/updates': case '/api/updates/check': return respond(unmanagedUpdates);
    case '/api/models': return respond({ models: [] });
    case '/api/machines': return respond({ machines: [{ id: 'local', name: 'Fixture Core', kind: 'local', defaultCwd: '/fixture' }] });
    case '/api/jobs': return respond(noJobs);
    case '/api/jobs/budget': return respond(budget);
    case '/api/jobs/live': return respond(noLiveJobs);
    case '/api/ci': return respond(noCiRuns);
    case '/api/reviews': return respond(noReviews);
    case '/api/catchup': return respond({ items: [], agents: [] });
    default: return respond(url.pathname.includes('/collaboration/') ? { tasks: [], messages: [], agents: [] } : {});
  }
});
const check = (name) => { checks.push(name); console.log(`PASS ${name}`); };
async function open() {
  await page.getByRole('button', { name: 'Settings and updates' }).click();
  await page.getByRole('searchbox', { name: 'Search settings' }).waitFor();
}
async function search(term) { await page.getByRole('searchbox', { name: 'Search settings' }).fill(term); }
async function closeDialog() { await page.getByRole('dialog').getByRole('button', { name: /^Close (dialog|jobs)$/ }).click(); }
try {
  await page.goto(origin);
  await open();
  assert.equal(await page.getByRole('tab').count(), 8);
  await search('上下文');
  const contextSelect = page.getByLabel('Context window & compaction agent');
  assert.equal(await contextSelect.inputValue(), '');
  assert.equal(await page.getByRole('button', { name: 'Open Context window & compaction' }).isEnabled(), false);
  await contextSelect.selectOption('pine');
  await page.getByRole('button', { name: 'Open Context window & compaction' }).click();
  await page.getByRole('dialog', { name: 'Pine · Agent settings' }).waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains('codex-context-settings'));
  assert.match(await page.locator('.codex-context-figure').innerText(), /Unknown/);
  check('context search opens the explicitly selected second Agent, focused on context; native state stays unknown');
  await closeDialog();
  await open(); await search('默认目录');
  await page.getByLabel('Project directories, repositories & services project').selectOption('orchard');
  await page.getByRole('button', { name: 'Open Project directories, repositories & services' }).click();
  await page.getByRole('dialog', { name: 'Projects', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Project name', { exact: true }).inputValue(), 'Orchard');
  assert.equal(await page.getByLabel('Default folder on Fixture Core').inputValue(), '/fixture/orchard');
  check('default-directory search opens the chosen project and its actual per-machine value');
  await closeDialog();
  await open(); await search('预算');
  await page.getByRole('button', { name: 'Open Core host Job budget', exact: true }).click();
  await page.locator('details.job-budget-settings[open]').waitFor();
  await page.waitForFunction(() => document.activeElement?.tagName === 'SUMMARY');
  check('budget search expands the existing Core machine budget editor');
  await page.getByRole('tab', { name: 'GitHub Actions', exact: true }).click();
  await page.getByRole('tab', { name: 'Local', exact: true }).click();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const budgetEditor = page.locator('details.job-budget-settings');
  await budgetEditor.waitFor();
  assert.equal(await budgetEditor.evaluate((el) => el.open), false, 'Budget request must be consumed before a source remount');
  assert.equal(await budgetEditor.locator('summary').evaluate((el) => document.activeElement === el), false, 'Returning to Local must keep focus on the user-selected tab');
  await closeDialog();
  await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  await budgetEditor.waitFor();
  assert.equal(await budgetEditor.evaluate((el) => el.open), false, 'Ordinary Jobs reopening must not replay the budget request');
  await closeDialog();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('yuzuno:open-job', { detail: { source: 'local' } })));
  await budgetEditor.waitFor();
  assert.equal(await budgetEditor.evaluate((el) => el.open), false, 'An ordinary openJobs request must not replay budget navigation');
  await closeDialog();
  await open(); await search('预算');
  await page.getByRole('button', { name: 'Open Core host Job budget', exact: true }).click();
  await page.locator('details.job-budget-settings[open]').waitFor();
  await page.waitForFunction(() => document.activeElement?.tagName === 'SUMMARY');
  check('budget navigation is consumed once: source remounts and ordinary openings keep it closed; a new explicit request still expands and focuses');
  await closeDialog();
  await open(); await search('自动继续');
  await page.getByLabel('Continue after Claude’s usage limit resets agent').selectOption('maple');
  await page.getByRole('button', { name: 'Open Continue after Claude’s usage limit resets' }).click();
  await page.getByLabel('After Claude’s usage limit resets').waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'agent-auto-continue');
  assert.equal(await page.getByLabel('After Claude’s usage limit resets').inputValue(), 'default');
  check('auto-continue search selects the eligible Claude Agent and focuses its unique inspector editor');
  for (const width of [1360, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await open();
    await page.getByRole('tab', { name: 'Updates & about' }).focus();
    await page.keyboard.press('Home');
    assert.equal(await page.getByRole('tab', { name: 'Appearance & interaction' }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getByRole('tab', { name: 'Notifications & attention' }).getAttribute('aria-selected'), 'true');
    await search('手机访问');
    await page.getByText('Unavailable here.', { exact: false }).waitFor();
    assert.equal(await page.locator('.settings-catalog-card button').count(), 0);
    const overflow = await page.getByRole('dialog').evaluate((el) => ({ width: innerWidth, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, scroll: el.scrollWidth, client: el.clientWidth }));
    assert.ok(overflow.left >= 0 && overflow.right <= width + 1 && overflow.scroll <= overflow.client + 1, JSON.stringify(overflow));
    await page.screenshot({ path: resolve(output, `settings-${width}.png`) });
    await closeDialog();
    check(`${width}px: keyboard category navigation, honest unavailable phone access and no dialog overflow`);
  }
  await page.setViewportSize({ width: 320, height: 300 });
  await open();
  await page.getByRole('combobox', { name: 'Settings category', exact: true }).selectOption('agents');
  await search('上下文');
  const shortSelect = page.getByLabel('Context window & compaction agent');
  await shortSelect.scrollIntoViewIfNeeded();
  await shortSelect.selectOption('pine');
  await shortSelect.focus();
  assert.equal(await shortSelect.evaluate((el) => document.activeElement === el), true);
  const shortAction = page.getByRole('button', { name: 'Open Context window & compaction' });
  await shortAction.scrollIntoViewIfNeeded();
  assert.equal(await shortAction.evaluate((el) => { const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && (hit === el || el.contains(hit)); }), true);
  assert.ok(await page.locator('.settings-pane').evaluate((el) => el.clientHeight >= 100), 'Short viewport retains at least 100px of scrollable content');
  await page.screenshot({ path: resolve(output, 'settings-320x300.png') });
  check('320x300 software-keyboard viewport: all categories in picker, editable object choice, focused control and hit-tested action');
  await closeDialog();
  await page.setViewportSize({ width: 320, height: 900 });
  await open();
  await page.getByRole('tab', { name: 'Appearance & interaction' }).click();
  const appearance = page.locator('.appearance-settings');
  assert.match(await appearance.getByRole('status').innerText(), /Using the defaults/);
  const protectedKeys = await page.evaluate(() => ({
    selected: localStorage.getItem('yuzuno.selected'),
    draft: localStorage.getItem('yuzuno.composer.v1:cedar'),
  }));
  await page.evaluate(() => {
    const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
    window.settingsFixtureRefusal = { save: true, reset: false };
    Storage.prototype.setItem = function(key, value) {
      if (key === 'yuzuno.appearance' && window.settingsFixtureRefusal.save) throw new DOMException('Fixture quota', 'QuotaExceededError');
      return set.call(this, key, value);
    };
    Storage.prototype.removeItem = function(key) {
      if (key === 'yuzuno.appearance' && window.settingsFixtureRefusal.reset) throw new DOMException('Fixture blocked', 'SecurityError');
      return remove.call(this, key);
    };
  });
  await appearance.getByRole('radio', { name: 'Dark Low light' }).check();
  assert.match(await appearance.getByRole('alert').innerText(), /Not saved on this device/);
  assert.equal(await page.evaluate(() => localStorage.getItem('yuzuno.appearance')), null);
  await closeDialog();
  await open();
  await page.getByRole('tab', { name: 'Appearance & interaction' }).click();
  assert.equal(await appearance.getByRole('radio', { name: 'Dark Low light' }).isChecked(), true);
  await appearance.getByRole('alert').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, 'appearance-save-refused-320.png') });
  await page.evaluate(() => { window.settingsFixtureRefusal.save = false; });
  await appearance.getByRole('button', { name: 'Try again' }).click();
  assert.match(await appearance.getByRole('status').innerText(), /^Saved on this device$/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('yuzuno.appearance')).theme), 'dark');
  check('320px: refused appearance save keeps the selected preview after reopening; retry persists only after storage permits it');
  await page.evaluate(() => { window.settingsFixtureRefusal.reset = true; });
  await appearance.getByRole('button', { name: 'Restore defaults' }).click();
  await appearance.getByRole('button', { name: 'Try again' }).click();
  assert.match(await appearance.getByRole('alert').innerText(), /Not saved on this device/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('yuzuno.appearance')).theme), 'dark');
  await page.evaluate(() => { window.settingsFixtureRefusal.reset = false; });
  await appearance.getByRole('button', { name: 'Try again' }).click();
  assert.match(await appearance.getByRole('status').innerText(), /^Defaults restored on this device$/);
  assert.equal(await page.evaluate(() => localStorage.getItem('yuzuno.appearance')), null);
  assert.deepEqual(await page.evaluate(() => ({
    selected: localStorage.getItem('yuzuno.selected'),
    draft: localStorage.getItem('yuzuno.composer.v1:cedar'),
  })), protectedKeys);
  check('appearance reset retry removes this override, preserves the selected Agent and draft, and never saves a defaults object');
  await closeDialog();
  assert.ok(!calls.some((call) => call.method !== 'GET' && /\/(settings|context\/apply|claude\/auto-continue|jobs\/budget|remote-access)(\/|$)/.test(call.path)), 'Navigation never saves, applies or connects');
  assert.deepEqual(errors, []);
  check('no setting writes, native Apply, remote-access changes or page errors');
} finally {
  await page.screenshot({ path: resolve(output, 'last-state.png') });
  await writeFile(resolve(output, 'last-state.html'), await page.content());
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ checks, errors, calls }, null, 2));
  await context.close(); await browser.close();
}
