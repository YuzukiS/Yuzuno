// Isolated Chromium only. No user's native window or daily Core is touched.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lab = dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(pathToFileURL(resolve(lab, '../../web/node_modules/playwright-core/index.mjs')));
const base = 'http://127.0.0.1:4357';
const mode = process.argv[2] || 'reading';
assert.ok(['reading', 'visual', 'live'].includes(mode));
const proc = JSON.parse(await readFile(resolve(lab, 'core-process.json'), 'utf8'));
assert.equal(proc.baseUrl, base);
const stat = await readFile(`/proc/${proc.pid}/stat`, 'utf8');
assert.equal(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], proc.startTicks);
assert.ok(proc.argv.includes(resolve(lab, 'core-data')));
const fixture = JSON.parse(await readFile(resolve(lab, 'fixture-manifest.json'), 'utf8'));
const report = { mode, startedAt: new Date().toISOString(), checks: [], browserErrors: [], writes: [], scope: 'Isolated Chromium and real isolated Core. Fixture scenarios are historical replay / synthetic snapshots, not fresh harness execution.' };
const record = (name, data = {}) => { report.checks.push({ name, ...data }); console.log(name); };
const api = async path => { const r = await fetch(base + '/api' + path); assert.ok(r.ok, await r.clone().text()); return r.json(); };
const detail = id => api(`/agents/${id}`);
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(100); }
  throw Error('Acceptance condition did not become true; no operation was retried');
}
const browser = await chromium.launch({ headless: true, executablePath: '/usr/sbin/chromium' });
let activePage;
async function contextFor(id, { theme = 'light', width = 1440 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addInitScript(({ id, theme }) => {
    localStorage.setItem('yuzuno.appearance', JSON.stringify({ theme, fontSize: 20 }));
    localStorage.setItem('yuzuno.selected', JSON.stringify(id));
  }, { id, theme });
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== base) return route.abort();
    if (['GET', 'HEAD'].includes(req.method())) return route.continue();
    report.writes.push({ path: url.pathname, method: req.method(), body: req.postData(), at: new Date().toISOString() });
    if (mode === 'live' || /^\/api\/agents\/[^/]+\/review$/.test(url.pathname)) return route.continue();
    return route.abort();
  });
  const page = await context.newPage(); activePage = page;
  page.on('pageerror', e => report.browserErrors.push(e.message));
  return { context, page };
}
async function openFixture(scenario) {
  const agent = fixture.syntheticFixtures[scenario];
  const before = await detail(agent.id);
  assert.ok(before.agent.unreadCount > 0, `Fixture ${scenario} is already read; stop Core then lab.py reset-read`);
  const result = await contextFor(agent.id);
  await result.page.goto(base + '/?shell=desktop');
  await result.page.getByRole('heading', { name: agent.name, exact: true }).waitFor();
  await result.page.locator('.conversation-scroll').waitFor();
  return { ...result, agent, before };
}
async function unchanged(id, before, duration = 1700) {
  await sleep(duration);
  const after = await detail(id);
  assert.equal(after.agent.reviewedSeq, before.agent.reviewedSeq);
  assert.equal(after.agent.unreadCount, before.agent.unreadCount);
  return after;
}
try {
  if (mode === 'reading') {
    {
      const { context, page, agent } = await openFixture('foreground');
      await page.bringToFront();
      const focus = await page.evaluate(() => ({ focused: document.hasFocus(), visibility: document.visibilityState }));
      assert.equal(focus.focused, true); assert.equal(focus.visibility, 'visible');
      await page.locator('.conversation-scroll').evaluate(e => { e.scrollTop = e.scrollHeight; });
      await until(async () => (await detail(agent.id)).agent.unreadCount === 0);
      assert.equal(await page.getByRole('button', { name: 'Mark read', exact: true }).count(), 0);
      record('foreground-latest-visible-automatically-marks-read', focus);
      await context.close();
    }
    {
      const { context, page, agent, before } = await openFixture('old-scroll');
      await page.locator('.conversation-scroll').evaluate(e => { e.scrollTop = 0; e.dispatchEvent(new Event('scroll')); });
      await unchanged(agent.id, before);
      record('reading-older-turns-keeps-new-updates-unread');
      await context.close();
    }
    {
      const { context, page, agent, before } = await openFixture('modal');
      await page.getByRole('button', { name: 'Create agent', exact: true }).click();
      const dialog = page.getByRole('dialog'); await dialog.waitFor();
      await unchanged(agent.id, before);
      assert.equal(await dialog.getByLabel(/lasting purpose|用途备注|purpose/i).count(), 0);
      await dialog.getByLabel('Name', { exact: true }).fill('Just a name');
      await dialog.getByLabel(/^Working folder/).fill(resolve(lab, 'task'));
      assert.equal(await dialog.getByRole('button', { name: 'Create agent', exact: true }).isEnabled(), true);
      await page.screenshot({ path: resolve(lab, 'create-without-purpose.png') });
      record('dialog-blocks-auto-read-and-create-requires-no-purpose');
      await context.close();
    }
    {
      const { context, page, agent, before } = await openFixture('background');
      // Chromium's headless tabs all report focused/visible, including inactive
      // tabs. Exercise the browser-state contract explicitly without pretending
      // this is a native Windows focus acceptance.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        window.dispatchEvent(new Event('blur'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const state = await page.evaluate(() => ({ focused: document.hasFocus(), visibility: document.visibilityState }));
      assert.ok(!state.focused && state.visibility === 'hidden');
      await unchanged(agent.id, before);
      record('emulated-background-document-does-not-mark-read', { ...state, limitation: 'DOM focus/visibility emulation; native Windows focus unchanged and not tested' });
      await context.close();
    }
    {
      const { context, page, agent, before } = await openFixture('source-jump');
      const row = page.locator(`.agent-row[data-agent-id="${agent.id}"]`);
      await row.locator('button.agent-work-summary').click();
      await page.locator('.source-highlight').first().waitFor();
      await unchanged(agent.id, before);
      record('summary-source-jump-does-not-implicitly-mark-read', { highlighted: await page.locator('.source-highlight').first().getAttribute('data-item-id') });
      await page.locator('.source-navigation').getByRole('button', { name: /Back to latest/i }).click();
      await until(async () => (await detail(agent.id)).agent.unreadCount === 0);
      record('explicit-return-to-latest-resumes-auto-read');
      await context.close();
    }
    {
      const { context, page, agent, before } = await openFixture('pending');
      await page.locator('.conversation-scroll').evaluate(e => { e.scrollTop = e.scrollHeight; });
      await until(async () => (await detail(agent.id)).agent.unreadCount === 0);
      const after = await detail(agent.id);
      assert.deepEqual(after.pending, before.pending);
      assert.equal(after.agent.pendingCount, 1);
      record('auto-read-keeps-pending-request-open', { staleHistoricalRequest: true, pendingId: after.pending[0].id });
      await context.close();
    }
    {
      const agent = fixture.syntheticFixtures.working;
      const { context, page } = await contextFor(agent.id);
      await page.goto(base + '/?shell=desktop');
      const row = page.locator(`.agent-row[data-agent-id="${agent.id}"]`);
      const summary = row.locator('button.agent-work-summary'); await summary.waitFor();
      // Store startup honestly marks an in-flight historical snapshot uncertain.
      // The warning must describe the latest turn, not resurface its old result.
      assert.match(await summary.innerText(), /上次执行是否完成尚未确认/);
      assert.doesNotMatch(await summary.innerText(), /Fixture delivery 14|OBSOLETE_GOAL/);
      await summary.click();
      const error = page.locator(`#runtime-error-${agent.id}.source-highlight`);
      await error.waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.id), `runtime-error-${agent.id}`);
      record('uncertain-latest-turn-replaces-old-delivery-and-links-runtime-error', { summary: await summary.innerText() });
      await context.close();
    }
    if (fixture.syntheticFixtures.plan) {
      const { context, page, agent, before } = await openFixture('plan');
      const summary = page.locator(`.agent-row[data-agent-id="${agent.id}"] button.agent-work-summary`);
      assert.match(await summary.innerText(), /Verify native plan source/);
      await summary.click();
      const anchor = page.locator(`[data-item-id="yuzuno-plan-${agent.latestTurnId}"].source-highlight`);
      await anchor.waitFor();
      assert.match(await anchor.innerText(), /Verify native plan source/);
      await unchanged(agent.id, before);
      record('native-plan-summary-opens-visible-original-plan-without-marking-read', { syntheticSnapshot: true, itemId: `yuzuno-plan-${agent.latestTurnId}` });
      await context.close();
    }
    if (fixture.syntheticFixtures['history-drag']) {
      const { context, page, agent, before } = await openFixture('history-drag');
      await page.locator(`.agent-row[data-agent-id="${agent.id}"] button.agent-work-summary`).click();
      const scroller = page.locator('.conversation-scroll');
      await scroller.evaluate(e => { e.scrollTop = 0; e.dispatchEvent(new Event('scroll')); });
      await unchanged(agent.id, before);
      const box = await scroller.boundingBox();
      await page.mouse.move(box.x + box.width - 3, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 3, box.y + box.height - 4, { steps: 15 });
      await page.mouse.up();
      const gap = await scroller.evaluate(e => e.scrollHeight - e.scrollTop - e.clientHeight);
      let method = 'Playwright mouse drag on browser scrollbar';
      if (gap > 8) {
        method = 'Emulated scrollbar pointer intent plus scroll geometry; headless scrollbar did not move to end';
        await scroller.evaluate(e => {
          e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          e.scrollTop = e.scrollHeight;
          e.dispatchEvent(new Event('scroll', { bubbles: true }));
          e.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        });
      }
      await until(async () => (await detail(agent.id)).agent.unreadCount === 0);
      record('user-scrollbar-return-to-latest-resumes-auto-read', { method });
      await context.close();
    }
    {
      const { context, page, agent } = await openFixture('old-scroll');
      await page.locator('.conversation-scroll').evaluate(e => { e.scrollTop = 0; e.dispatchEvent(new Event('scroll')); });
      await page.getByRole('button', { name: 'Conversation actions', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Mark all as read', exact: true }).click();
      await until(async () => (await detail(agent.id)).agent.unreadCount === 0);
      record('manual-mark-all-remains-a-secondary-explicit-action');
      await context.close();
    }
  } else if (mode === 'visual') {
    const id = fixture.syntheticFixtures.working.id;
    for (const width of [1440, 900]) for (const theme of ['light', 'dark']) {
      const { context, page } = await contextFor(id, { width, theme });
      await page.goto(base + '/?shell=desktop');
      await page.getByRole('heading', { name: fixture.syntheticFixtures.working.name, exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: resolve(lab, `reading-${width}-${theme}-20px.png`) });
      const geometry = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth, fontSize: document.documentElement.dataset.fontSize, theme: document.documentElement.dataset.theme }));
      assert.ok(geometry.content <= geometry.width);
      record(`viewport-${width}-${theme}-20px`, geometry);
      await context.close();
    }
    report.nativeLimitation = 'Headless Chromium only; not a new Windows WebView2 or DPI acceptance.';
  } else if (mode === 'live') {
    // Explicit separate command; do not invoke until root authorizes the model case.
    report.scope = 'One new bounded WSL native Claude Haiku task through real GUI; reading/task only.';
    const name = `Reading live ${Date.now()}`, marker = `READING_${Date.now()}`;
    const { context, page } = await contextFor('');
    await page.goto(base + '/?shell=desktop');
    await page.getByRole('button', { name: 'Create agent', exact: true }).click();
    const dialog = page.getByRole('dialog');
    assert.equal(await dialog.getByLabel(/lasting purpose|用途备注|purpose/i).count(), 0);
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await dialog.getByLabel(/^Working folder/).fill(resolve(lab, 'task'));
    await dialog.getByLabel('Harness', { exact: true }).selectOption('claude');
    await dialog.getByLabel('Model', { exact: true }).fill('haiku');
    await dialog.getByRole('button', { name: 'Create agent', exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    const agent = (await api('/workspace')).agents.find(a => a.name === name);
    assert.ok(agent); assert.equal(agent.goal || '', '');
    record('real-gui-create-without-goal', { agentId: agent.id });
    await page.getByRole('textbox', { name: `Message ${name}`, exact: true }).fill(`Reply with exactly ${marker}. Do not use any tools, read files, or perform other actions.`);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await until(async () => {
      const d = await detail(agent.id);
      if (['error', 'uncertain'].includes(d.agent.status)) throw Error(d.agent.error || d.agent.status);
      return d.turns.at(-1)?.status === 'completed';
    }, 120000);
    await page.locator('.final-message').filter({ hasText: marker }).waitFor();
    await page.locator('.conversation-scroll').evaluate(e => { e.scrollTop = e.scrollHeight; });
    await until(async () => (await detail(agent.id)).agent.unreadCount === 0);
    const final = await detail(agent.id);
    assert.ok(final.agent.claudeSessionId);
    record('real-native-claude-reply-visible-and-automatically-read', { agentId: agent.id, sessionId: final.agent.claudeSessionId, marker });
    await page.screenshot({ path: resolve(lab, 'live-claude-reading.png') });
    await writeFile(resolve(lab, 'live-state.json'), JSON.stringify({ agentId: agent.id, name, marker }, null, 2));
    await context.close();
  }
  assert.equal(report.browserErrors.length, 0);
  report.passed = true;
} catch (e) {
  await activePage?.screenshot({ path: resolve(lab, `${mode}-failure.png`) }).catch(() => {});
  report.error = e.stack; report.passed = false;
  throw e;
} finally {
  await writeFile(resolve(lab, `${mode}-report.json`), JSON.stringify(report, null, 2));
  await browser.close();
}
