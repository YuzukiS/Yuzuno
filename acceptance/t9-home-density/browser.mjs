// T-9: Home cards an Agent writes through the real MCP brief_update of an
// isolated Core, shown at both densities. Titles, values, steps and the image
// are random for each run (the seed is in the report). Only the native model
// transport is a fixture: no paid model, no daily Core.
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { chromium } from '../../web/node_modules/playwright-core/index.mjs';

const lab = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.match(lab.url, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.notEqual(new URL(lab.url).port, '4317');
const seed = randomBytes(4).toString('hex');
const report = { seed, checks: [], errors: [], screenshots: [], observations: [], passed: false,
  scope: 'real isolated Core/UI/MCP brief_update as an Agent identity; payloads random per run; deterministic Codex native transport, no paid model' };
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
let sequence = 0;
async function rpc(method, params = {}) {
  const client = lab.clients.writer;
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
const tool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).structuredContent;
async function update(changes) {
  const brief = await tool('brief_get', { keys: [] });
  return tool('brief_update', { requestId: `t9-${seed}-${++sequence}`, expectedVersion: brief.version, changes });
}
const sectionOf = async key => (await tool('brief_get', { keys: [key] })).sections.find(section => section.key === key);

// Random content.
const words = ['amber', 'birch', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'harbor', 'iris', 'juniper', 'kestrel', 'lumen', 'maple', 'nectar', 'opal', 'quartz'];
const shuffled = [...words].sort(() => randomInt(3) - 1);
const word = () => words[randomInt(words.length)];
const titled = what => `${what} ${word()}-${randomInt(100, 1000)}`;
const body = (elements, children) => ({ root: 'body', elements: { body: { type: 'BriefBody', props: {}, children }, ...elements } });

function png(width, height) {
  const [a, b] = [0, 1].map(() => [randomInt(256), randomInt(256), randomInt(256)]);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = [0];
    for (let x = 0; x < width; x++) row.push(...((Math.floor(x / 20) + Math.floor(y / 20)) % 2 ? a : b));
    rows.push(...row);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tagged = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(tagged));
    return Buffer.concat([head, tagged, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
}

// The plan: a few done, one doing, the last blocked, past the short window.
const stepCount = randomInt(8, 12);
const doneCount = randomInt(1, stepCount - 4);
const steps = Array.from({ length: stepCount }, (_, i) => ({
  id: `s${i}`,
  text: `${shuffled[i % shuffled.length]} step ${i + 1}\nWhy ${word()} ${i + 1}`,
  state: i < doneCount ? 'done' : i === doneCount ? 'doing' : i === stepCount - 1 ? 'blocked' : 'todo',
}));
const planTitle = titled('Plan');
const metricsItems = () => [
  { label: 'Memory', value: randomInt(40, 900), unit: 'MiB', previous: randomInt(40, 900), detail: `sample ${word()}` },
  { label: 'Threads', value: randomInt(1, 64) },
  { label: 'Reads', value: 'unknown' },
  { label: 'Held', value: 0 },
  { label: 'Runs', value: randomInt(1, 500), unit: 'runs', previous: randomInt(1, 500) },
  { label: 'Latency', value: Number((randomInt(10, 900) / 10).toFixed(1)), unit: 'ms' },
];
const firstMetrics = metricsItems();
const trend = Array.from({ length: randomInt(8, 25) }, (_, i) => [i + 1, randomInt(50, 400)]);
const runs = shuffled.slice(0, 6).map((name, i) => ({ id: `r${i}`, cells: { run: name, score: randomInt(10, 100) } }));
const numbersTitle = titled('Numbers');
const deliverableTitle = titled('Deliverable');
const questionTitle = titled('Question');
const shot = `shot-${seed}.png`;
const files = { [shot]: png(240, 150), 'second.png': png(120, 80), 'run.log': Buffer.from(`run ${seed}\nok\n`), 'empty.csv': Buffer.from('t,rss\n') };
for (const [name, data] of Object.entries(files)) await writeFile(`${lab.files}/${name}`, data);
const metricsBlock = items => ({ type: 'Metrics', props: { items } });
const numbersElements = withEmpty => ({
  metrics: metricsBlock(firstMetrics),
  trend: { type: 'LineChart', props: { id: 'trend', title: 'Trend', x: { label: 'Sample' }, y: { label: 'Memory', unit: 'MiB' }, series: [{ name: 'RSS', points: trend }] } },
  ...(withEmpty ? { empty: { type: 'LineChart', props: { id: 'empty', title: 'Empty trend', x: { label: 't' }, y: { label: 'Memory', unit: 'MiB' },
    data: { attachment: 'empty.csv', x: 't', series: [{ name: 'RSS', column: 'rss' }] } } } } : {}),
  runs: { type: 'Table', props: { id: 'runs', title: 'Runs', columns: [{ key: 'run', label: 'Run' }, { key: 'score', label: 'Score' }], rows: runs } },
});
const numbers = withEmpty => ({ op: 'put', key: 'numbers', kind: 'report', title: numbersTitle,
  attachments: withEmpty ? [{ name: 'empty.csv', path: `${lab.files}/empty.csv` }] : [],
  body: body(numbersElements(withEmpty), ['metrics', 'trend', ...(withEmpty ? ['empty'] : []), 'runs']) });
const sections = [
  { op: 'put', key: 'plan', kind: 'status', title: planTitle, status: { asOf: new Date().toISOString(), validFor: 3600 },
    body: body({ plan: { type: 'Plan', props: { title: 'Steps', steps } } }, ['plan']) },
  { op: 'put', key: 'deliverable', kind: 'report', title: deliverableTitle,
    attachments: [shot, 'second.png', 'run.log'].map(name => ({ name, path: `${lab.files}/${name}` })),
    body: body({ files: { type: 'Attachments', props: { items: [{ name: shot, caption: `Screen ${word()}` }, { name: 'second.png' }, { name: 'run.log' }] } } }, ['files']) },
  { op: 'put', key: 'question', kind: 'ask', title: questionTitle, body: body({ text: { type: 'Markdown', props: { text: 'Which run should be kept?' } } }, ['text']),
    ask: { question: 'Which run should be kept?', reply: { freeText: true } } },
];

const browser = await chromium.launch({ executablePath: process.env.YUZUNO_BROWSER_BIN || '/usr/sbin/chromium',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on('pageerror', error => report.errors.push(error.message));
const writes = [];
page.on('request', request => { if (request.method() !== 'GET') writes.push(`${request.method()} ${new URL(request.url()).pathname}`); });
const card = key => page.locator(`[id="home-section-${lab.project}-${key}"]`);
// Home scrolls inside the app, so a page screenshot shows only the
// viewport: the window is made as tall as Home's content for the shot.
const homeOverflow = () => page.evaluate(() => {
  for (let el = document.querySelector('.home-view'); el && el !== document.body; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight)
      return { extra: el.scrollHeight - el.clientHeight, wide: el.scrollWidth > el.clientWidth + 1 };
  }
  return { extra: 0, wide: false };
});
const shoot = async name => {
  const size = page.viewportSize();
  const { extra } = await homeOverflow();
  if (extra > 0) await page.setViewportSize({ width: size.width, height: Math.min(size.height + extra, 8000) });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${lab.output}/${name}`, fullPage: true });
  await page.setViewportSize(size);
  report.screenshots.push(name);
};
const density = () => page.locator('.home-view').getAttribute('data-density');
const choose = async label => {
  await page.locator('.home-density').getByRole('button', { name: label, exact: true }).click();
  await page.waitForFunction(want => document.querySelector('.home-view')?.dataset.density === want, label.startsWith('Low') ? 'low' : 'high');
};
const noOverflow = async () =>
  !(await homeOverflow()).wide && await page.evaluate(() => [document.documentElement, document.querySelector('.home-view')]
    .every(el => el.scrollWidth <= el.clientWidth + 1));
// A metric by its exact label ("Reads" is also inside "Threads").
const metric = label => card('numbers').locator('.brief-metrics > div').filter({ has: page.locator('dt').getByText(label, { exact: true }) });
const plotHeight = title => card('numbers').locator(`.brief-chart[aria-label="${title}"] .brief-chart-plot`).evaluate(el => el.getBoundingClientRect().height);
// What both densities must agree on: every metric's value and comparison,
// every step's state, the done count, and where the chart data came from.
const facts = () => page.evaluate(project => {
  const within = key => document.getElementById(`home-section-${project}-${key}`);
  const metrics = Object.fromEntries([...within('numbers').querySelectorAll('.brief-metrics > div')].map(div => [
    div.querySelector('dt').textContent, { value: div.querySelector('dd').textContent, delta: div.querySelector('.brief-delta')?.textContent ?? null }]));
  const plan = within('plan');
  return {
    metrics,
    steps: [...plan.querySelectorAll('.brief-plan li')].map(li => [li.value, li.dataset.state]),
    done: plan.querySelector('.brief-plan header span').textContent,
    stale: plan.classList.contains('is-stale'),
    chartFoot: [...within('numbers').querySelectorAll('.brief-chart-foot')].map(foot => foot.textContent),
  };
}, lab.project);
const expandAll = async () => {
  for (const selector of ['.brief-plan-all', '.brief-metrics-more', '.brief-attachments-more']) {
    const button = page.locator(selector);
    if (await button.count() && (await button.getAttribute('aria-expanded')) === 'false') await button.click();
  }
};
const collapseAll = async () => {
  for (const selector of ['.brief-plan-all', '.brief-metrics-more', '.brief-attachments-more']) {
    const button = page.locator(selector);
    if (await button.count() && (await button.getAttribute('aria-expanded')) === 'true') await button.click();
  }
};
try {
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't9-acceptance', version: '1' } });
  // An empty trend can only come from a data file; whether Core takes one
  // with no rows is recorded, not assumed.
  let withEmpty = true;
  let written = await update([numbers(true), ...sections]);
  if (!written.accepted) {
    report.observations.push({ emptyDataChartRefused: written.problems });
    withEmpty = false;
    written = await update([numbers(false), ...sections]);
  }
  assert.equal(written.accepted, true, JSON.stringify(written.problems));
  check('an Agent writes a plan, metrics with a trend and a table, a deliverable with a random image and an Ask through MCP brief_update');

  await page.goto(lab.url);
  await page.locator('.toolbar-nav button[title^="Home"]').click();
  for (const key of ['plan', 'numbers', 'deliverable', 'question']) await card(key).waitFor();
  assert.equal(await density(), 'low');
  const group = page.locator('.home-density');
  assert.equal(await group.getByRole('button', { name: 'Low density', exact: true }).getAttribute('aria-pressed'), 'true');
  // Low: the plan's window, the blocked step after it, nothing else.
  const windowStart = doneCount - 1;
  const rows = await card('plan').locator('.brief-plan li').evaluateAll(lis => lis.map(li => [li.value, li.dataset.state, li.dataset.gap ?? null]));
  assert.deepEqual(rows.map(([value]) => value), [...Array.from({ length: 5 }, (_, i) => windowStart + i + 1), stepCount]);
  // A gap before it only when it doesn't follow the window's last step.
  assert.deepEqual(rows.at(-1), [stepCount, 'blocked', stepCount - 1 > windowStart + 5 ? 'true' : null]);
  assert.match(await card('plan').locator('.brief-plan header span').textContent(), new RegExp(`${doneCount} of ${stepCount} done`));
  assert.equal(await card('plan').locator('.brief-plan-all').textContent(), `Show all ${stepCount} steps`);
  // Low metrics: the lead value large, three more, the rest counted with a button.
  const lead = card('numbers').locator('.brief-metrics > [data-lead]');
  assert.equal(await lead.locator('dd').textContent(), `${firstMetrics[0].value}MiB`);
  assert.match(await lead.textContent(), new RegExp(firstMetrics[0].detail));
  assert.equal(await card('numbers').locator('.brief-metrics > div').count(), 4);
  assert.equal(await card('numbers').locator('.brief-metrics-more').textContent(), 'Show 2 more');
  assert.equal(await metric('Reads').locator('dd').textContent(), 'unknown', 'an unknown value is not 0');
  assert.equal(await metric('Held').locator('dd').textContent(), '0', 'a real 0 is 0');
  assert.equal(await card('numbers').locator('.brief-chart[aria-label="Trend"]').getAttribute('data-density'), 'low');
  assert.ok(Math.abs(await plotHeight('Trend') - 120) <= 1, `a low-density trend is 120 px tall: ${await plotHeight('Trend')}`);
  if (withEmpty) {
    await card('numbers').locator('.brief-chart[aria-label="Empty trend"] .brief-chart-state').filter({ hasText: 'No points to show.' }).waitFor();
    check('an empty trend from a data file says it has no points, at low density');
  }
  // Low deliverable: the first image, loaded; the rest one click away.
  const image = card('deliverable').locator(`.brief-attachment img[alt]`).first();
  await image.waitFor();
  // The image loads lazily: only once Home's scroller brings it into view.
  await image.scrollIntoViewIfNeeded();
  await page.waitForFunction(project => {
    const img = document.getElementById(`home-section-${project}-deliverable`)?.querySelector('.brief-attachment img');
    return img && img.complete && img.naturalWidth === 240;
  }, lab.project);
  assert.deepEqual(await card('deliverable').locator('.brief-attachments > li strong').allTextContents(), [shot]);
  assert.equal(await card('deliverable').locator('.brief-attachments-more').textContent(), 'Show all 3 attachments');
  check('low density by default: the plan window plus the blocked step, the lead metric, a compact trend, the first deliverable image');
  assert.ok(await noOverflow());
  await shoot('desktop-low.png');

  await expandAll();
  await card('plan').locator('.brief-plan li').nth(stepCount - 1).waitFor();
  assert.equal(await card('numbers').locator('.brief-metrics > div').count(), 6);
  const low = await facts();
  await collapseAll();
  const writesBefore = writes.length;
  await choose('High density');
  await page.waitForTimeout(500);
  // Home's repository read is a POST of its own; nothing else may be sent.
  const sent = writes.slice(writesBefore);
  report.observations.push({ requestsWhileSwitching: sent });
  assert.deepEqual(sent.filter(request => request !== 'POST /api/collaboration/github_repositories'), [], 'switching sends no POST, PUT, PATCH or DELETE besides the repository read');
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('yuzuno.homeDensity')).length), 1);
  const saved = await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('yuzuno.homeDensity.')));
  assert.ok(saved && saved[1] === '"high"', `kept for this Workspace: ${JSON.stringify(saved)}`);
  const high = await facts();
  assert.ok(Math.abs(await plotHeight('Trend') - 260) <= 1, `a high-density trend is 260 px tall: ${await plotHeight('Trend')}`);
  assert.deepEqual(high, low, 'both densities show the same values, states, counts and sources');
  assert.equal(await card('plan').locator('.brief-plan-all').count(), 0);
  assert.deepEqual(await card('deliverable').locator('.brief-attachments > li strong').allTextContents(), [shot, 'second.png', 'run.log']);
  check('high density shows every step, metric and attachment; values, comparisons, states, counts and sources match low density');
  assert.ok(await noOverflow());
  await shoot('desktop-high.png');
  await page.reload();
  await page.locator('.toolbar-nav button[title^="Home"]').click();
  await card('numbers').waitFor();
  // Home may draw before the Workspace is known (low until then); the
  // Workspace's own choice follows.
  await page.waitForFunction(() => document.querySelector('.home-view')?.dataset.density === 'high', null, { timeout: 10000 });
  check('high density is kept on this device for this Workspace across a reload; nothing is sent to Core for it');

  await page.setViewportSize({ width: 393, height: 852 });
  await card('numbers').waitFor();
  assert.ok(await noOverflow(), 'no horizontal overflow at 393 px, high');
  await shoot('mobile-high.png');
  await choose('Low density');
  assert.ok(await noOverflow(), 'no horizontal overflow at 393 px, low');
  await shoot('mobile-low.png');
  check('393 px wide: both densities without horizontal overflow');

  // 320 px with two projects: the header (title, both densities, Reorder,
  // Refresh) wraps, and every control stays on screen.
  await page.setViewportSize({ width: 320, height: 700 });
  await card('numbers').waitFor();
  assert.equal(await page.locator('.home-header').getByRole('button', { name: 'Reorder', exact: true }).count(), 1, 'two projects: Reorder shows');
  const headerFits = () => page.locator('.home-header button').evaluateAll(buttons =>
    buttons.every(button => { const r = button.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= document.documentElement.clientWidth + 1; }));
  for (const label of ['Low density', 'High density']) {
    await choose(label);
    assert.ok(await headerFits(), `every header control is on screen at 320 px, ${label}`);
    assert.ok(await noOverflow(), `no horizontal overflow at 320 px, ${label}`);
    await shoot(`mobile-320-${label.startsWith('Low') ? 'low' : 'high'}.png`);
  }
  await choose('Low density');
  check('320 px wide with two projects: the header wraps, every control stays on screen, no horizontal overflow');

  await page.setViewportSize({ width: 1440, height: 1000 });
  // One block edited: the others, a draft, focus and a table filter stay.
  const filter = card('numbers').getByRole('textbox', { name: 'Filter Runs', exact: true });
  const kept = runs[randomInt(runs.length)].cells.run;
  await filter.fill(kept);
  await page.waitForFunction(project => document.getElementById(`home-section-${project}-numbers`).querySelectorAll('.result-table-scroll tbody tr').length === 1, lab.project);
  const draft = `Keep ${kept}, ${word()}`;
  await card('question').getByRole('textbox', { name: `Reply to ${questionTitle}`, exact: true }).fill(draft);
  await filter.focus();
  await page.evaluate(project => {
    const within = key => document.getElementById(`home-section-${project}-${key}`);
    window.__t9 = { table: within('numbers').querySelector('.result-table-scroll'), trend: within('numbers').querySelector('.brief-chart'), plan: within('plan').querySelector('.brief-plan') };
  }, lab.project);
  const before = await sectionOf('numbers');
  const next = metricsItems();
  const edited = await update([{ op: 'edit', key: 'numbers', elements: { metrics: metricsBlock(next) } }]);
  assert.equal(edited.accepted, true, JSON.stringify(edited.problems));
  await page.waitForFunction(([project, value]) =>
    document.getElementById(`home-section-${project}-numbers`)?.querySelector('.brief-metrics > [data-lead] dd')?.textContent === value,
  [lab.project, `${next[0].value}MiB`], { timeout: 15000 });
  const draftNow = await card('question').getByRole('textbox', { name: `Reply to ${questionTitle}`, exact: true }).inputValue();
  const after = await page.evaluate((project) => {
    const within = key => document.getElementById(`home-section-${project}-${key}`);
    const filterInput = within('numbers').querySelector('input[aria-label="Filter Runs"]');
    return {
      filter: filterInput.value,
      rows: within('numbers').querySelectorAll('.result-table-scroll tbody tr').length,
      focus: document.activeElement === filterInput,
      sameTable: window.__t9.table === within('numbers').querySelector('.result-table-scroll'),
      sameTrend: window.__t9.trend === within('numbers').querySelector('.brief-chart'),
      samePlan: window.__t9.plan === within('plan').querySelector('.brief-plan'),
    };
  }, lab.project);
  assert.deepEqual({ ...after, draft: draftNow }, { filter: kept, rows: 1, focus: true, draft, sameTable: true, sameTrend: true, samePlan: true });
  const editedVersion = (await sectionOf('numbers')).version;
  assert.ok(editedVersion > before.version);
  check('a single-block edit redraws only that block: the table filter, focus, the Ask draft and the other blocks stay');

  // Refused writes: Core says why, and the card keeps what it showed.
  const shown = await card('numbers').getAttribute('data-section-version');
  const invalidPut = await update([{ ...numbers(false), body: body({ metrics: metricsBlock([]) }, ['metrics']) }]);
  assert.equal(invalidPut.accepted, false);
  assert.ok(invalidPut.problems?.length, 'a put with no metrics names its problem');
  const invalidEdit = await update([{ op: 'edit', key: 'numbers', elements: { trend: { type: 'LineChart', props: { id: 'trend', title: 'Trend', x: { label: 'Sample' }, y: { label: 'Memory' }, series: [{ name: 'RSS', points: [] }] } } } }]);
  assert.equal(invalidEdit.accepted, false);
  assert.ok(invalidEdit.problems?.length, 'an edit with an empty series names its problem');
  report.observations.push({ refused: { put: invalidPut.problems.map(p => p.code), edit: invalidEdit.problems.map(p => p.code) } });
  await page.locator('.home-header').getByRole('button', { name: 'Refresh Home' }).click();
  await page.waitForTimeout(1500);
  assert.equal(await card('numbers').getAttribute('data-section-version'), shown);
  assert.equal(await card('numbers').locator('.brief-metrics > [data-lead] dd').textContent(), `${next[0].value}MiB`);
  assert.equal(await card('numbers').locator('.brief-chart[aria-label="Trend"] .brief-chart-state').count(), 0);
  assert.equal((await sectionOf('numbers')).version, editedVersion, 'Core kept the last good version');
  check('an invalid put and an invalid edit are refused by Core with their problems, and the card keeps its last good version');

  // My widgets (PR B): only what the user pins, with Machines, in a grid of
  // two columns on a wide pane and one on a phone, in the same order;
  // between Needs you and the projects; arranged only in Organize.
  const widgetsArea = page.locator('.home-widget-column');
  const slots = () => page.locator('.home-widget-grid > .home-widget-slot').evaluateAll(all => all.map(slot => slot.dataset.widget));
  const columns = () => page.locator('.home-widget-grid').evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
  const savedLayout = () => page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('yuzuno.homeWidgets.'))?.[1] ?? null);
  assert.deepEqual(await slots(), ['machines'], 'nothing is pinned for the user');
  assert.equal(await widgetsArea.locator('.home-widget-count').textContent(), '0 pinned');
  for (const key of ['plan', 'numbers']) await card(key).locator('.home-pin').click();
  await page.waitForFunction(() => document.querySelectorAll('.home-widget-grid > .home-widget-slot').length === 3);
  const pinned = await slots();
  assert.equal(pinned[0], 'machines');
  assert.match(pinned[1], /:plan$/);
  assert.match(pinned[2], /:numbers$/);
  assert.equal(await widgetsArea.locator('.home-widget-count').textContent(), '2 pinned');
  assert.equal(await columns(), 2, 'two columns on a wide pane');
  const box = selector => page.locator(selector).first().evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
  const [needsBox, widgetsBox, projectBox] = [await box('.home-needs-area'), await box('.home-widget-column'), await box('.home-main')];
  assert.ok(needsBox.bottom <= widgetsBox.top + 1 && widgetsBox.bottom <= projectBox.top + 1, `Needs you, My widgets, projects: ${JSON.stringify({ needsBox, widgetsBox, projectBox })}`);
  assert.ok(await card('plan').isVisible() && await card('numbers').isVisible(), 'the project cards stay where they are');
  assert.ok(await noOverflow());
  await shoot('widgets-desktop.png');
  check('pinned cards join Machines in a two-column grid between Needs you and the projects; nothing is pinned for the user and project cards stay');

  // An Agent's update changes a pinned card's content, never its place.
  const layoutBefore = await savedLayout();
  const renamed = `${steps[doneCount].text.split('\n')[0]} (revised ${word()})`;
  const revised = steps.map((step, i) => i === doneCount ? { ...step, text: `${renamed}\nRevised by the Agent` } : step);
  const planEdit = await update([{ op: 'edit', key: 'plan', elements: { plan: { type: 'Plan', props: { title: 'Steps', steps: revised } } } }]);
  assert.equal(planEdit.accepted, true, JSON.stringify(planEdit.problems));
  await page.waitForFunction(([id, text]) => document.querySelector(`.home-widget-grid > [data-widget="${id}"]`)?.textContent.includes(text), [pinned[1], renamed], { timeout: 15000 });
  assert.deepEqual(await slots(), pinned, 'the order is the same');
  assert.equal(await savedLayout(), layoutBefore, 'the saved layout is unchanged');
  check("an Agent's update shows in its pinned card and leaves the order and the saved layout unchanged");

  // Organize: move, hide, show; kept for this Workspace.
  await widgetsArea.getByRole('button', { name: 'Organize', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Organize my widgets').waitFor();
  await dialog.getByRole('button', { name: `Move ${numbersTitle} up`, exact: true }).click();
  await dialog.getByRole('button', { name: 'Hide Machines', exact: true }).click();
  await dialog.getByRole('button', { name: 'Show Machines', exact: true }).waitFor();
  await shoot('organize.png');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(await slots(), [pinned[2], pinned[1]], 'numbers first, Machines hidden');
  await page.reload();
  await page.locator('.toolbar-nav button[title^="Home"]').click();
  await page.waitForFunction(order => JSON.stringify([...document.querySelectorAll('.home-widget-grid > .home-widget-slot')].map(slot => slot.dataset.widget)) === order,
    JSON.stringify([pinned[2], pinned[1]]), { timeout: 10000 });
  check('Organize moves and hides widgets in a dialog; the layout is kept for this Workspace across a reload');

  // A phone: one column, the same order.
  await page.setViewportSize({ width: 393, height: 852 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.home-widget-grid')).gridTemplateColumns.split(' ').length === 1);
  assert.deepEqual(await slots(), [pinned[2], pinned[1]]);
  assert.ok(await noOverflow(), 'no horizontal overflow at 393 px');
  await shoot('widgets-mobile.png');
  check('393 px wide: My widgets is one column in the same order, without horizontal overflow');

  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack || String(error);
  await page.screenshot({ path: `${lab.output}/failure.png`, fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await writeFile(`${lab.output}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
  if (report.failure) console.error(report.failure);
}
