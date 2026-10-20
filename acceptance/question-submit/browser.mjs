import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '../../web/node_modules/playwright-core/index.mjs';

const base = process.env.T67_BASE;
const out = process.env.T67_CASE;
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.notEqual(new URL(base).port, '4317');
assert.ok(out);
const browser = await chromium.launch({executablePath: process.env.YUZUNO_BROWSER_BIN || '/usr/sbin/chromium', headless: true, args: ['--disable-dev-shm-usage']});
const errors = [], requests = [];
let report;
try {
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await context.addInitScript(() => {
    localStorage.setItem('yuzuno.selected', 'a');
    localStorage.setItem('yuzuno.appearance', JSON.stringify({theme: 'light',fontSize:20,palette:'garden'}));
    window.t67 = {runs: [], current: null};
    const now = () => performance.timeOrigin + performance.now();
    const stamp = (key) => {
      const run = window.t67.current;
      if (run && run[key] == null) {
        run[key] = now();
        if (key === 'busyCommit') requestAnimationFrame(() => requestAnimationFrame(() => run.busyFrameOpportunity = now()));
      }
    };
    document.addEventListener('click', event => {
      if (event.target.closest('button')?.matches('[data-t67-submit]')) stamp('click');
    }, true);
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      const run = window.t67.current;
      const tracked = run && init?.method === 'POST' && /\/(messages|respond)$/.test(String(url));
      if (tracked) { run.requestStart = now(); run.requestBody = JSON.parse(init.body); run.requestPath = String(url); }
      const response = await originalFetch(url, init);
      if (tracked) {
        run.responseHeaders = now();
        const originalJson = response.json.bind(response);
        response.json = async () => { const body = await originalJson(); run.responseJson = now(); run.responseBody = body; return body; };
      }
      return response;
    };
    new MutationObserver(() => {
      const run = window.t67.current;
      if (!run?.click) return;
      const scope = document.querySelector(run.selector);
      const button = scope?.querySelector('[data-t67-submit]');
      if (button?.disabled && (button.querySelector('.spin') || /Sending/.test(button.textContent))) stamp('busyCommit');
      if (run.kind === 'native') {
        if (/Response sent/.test(scope?.textContent || '')) stamp('acceptedCommit');
        if (!scope) stamp('resolvedCommit');
      } else if (/Answer sent|Answers sent/.test(button?.textContent || '')) stamp('acceptedCommit');
    }).observe(document, {subtree:true,childList:true,attributes:true,characterData:true});
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() !== 'GET') requests.push({method:request.method(),url:request.url()}); });
  await page.goto(base);
  await page.locator('[data-composer-input]').waitFor();
  async function submit(kind, selector, button) {
    await button.evaluate(button => button.setAttribute('data-t67-submit', ''));
    await page.evaluate(({kind,selector}) => {
      window.t67.current = {kind,selector,domNodes:document.querySelectorAll('*').length};
      window.t67.runs.push(window.t67.current);
    }, {kind,selector});
    await button.click();
    await page.waitForFunction(() => {
      const run = window.t67.current;
      return run.responseJson && (run.kind === 'native' ? run.resolvedCommit : run.acceptedCommit);
    }, null, {timeout:30_000});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => { window.t67.current.completedFrameOpportunity = performance.timeOrigin + performance.now(); window.t67.current=null; });
  }
  await page.locator('.pending-card').getByLabel('Your answer: Native timing question').fill('native answer 中文');
  await submit('native','.pending-card',page.locator('.pending-card').getByRole('button',{name:'Send answer',exact:true}));
  await page.locator('.question-dock-open').click();
  await page.locator('.async-question').getByLabel('Your answer: Async timing question').fill('async answer 中文');
  await submit('async','.async-question',page.locator('.async-question').getByRole('button',{name:'Send answer',exact:true}));
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.locator('.clarification').getByLabel('Form timing answer').fill('form answer 中文');
  await submit('form','.clarification',page.locator('.clarification').getByRole('button',{name:'Submit answers',exact:true}));
  report = await page.evaluate(() => window.t67.runs);
  assert.equal(report.length,3);
  for (const row of report) {
    assert.ok(row.click && row.requestStart && row.responseJson);
    if (row.kind !== 'native') assert.equal(row.responseBody.status,'accepted');
  }
  assert.equal(requests.filter(r => /\/(respond|messages)$/.test(r.url)).length,3);
  assert.deepEqual(errors,[]);
  await writeFile(out+'/browser.json',JSON.stringify({runs:report,errors,requests,passed:true},null,2));
} catch (error) {
  await writeFile(out+'/failure.json',JSON.stringify({error:String(error),stack:error.stack,errors,requests},null,2));
  throw error;
} finally { await browser.close(); }
