// T-25 live acceptance: Claude's background tasks in a candidate Core built
// from this worktree (port 4495, its own data), with the real installed
// Claude Code and Haiku, and the page in headless Chromium. Never touches the
// daily Core, its data or windows; the only processes it starts or signals
// are this lab's Core (its bridge and CLI with it) and the lab's own `sleep`
// commands, which carry a marker.
//
// 1. One turn starts three background shells (alpha 30 s, beta 120 s, delta
//    exits 3 after 3 s); each Bash call is approved in the page. The turn
//    ends; the dock's "Background tasks" group lists them.
// 2. Beta is stopped from its card in the dock: one POST, "Stopping…", then
//    stopped by Claude's own report; alpha keeps running.
// 3. Delta ends as failed; alpha completes by itself after the turn ended,
//    while Claude may run turns of its own, and lands on its own call.
// 4. The session goes on: a new prompt is answered (not a Turn of Claude's
//    own about a task that ended; lab r2 picked one of those up).
// 5. Refusals: an ended task, an unknown id.
// 6. A fourth shell (gamma) runs; Core restarts: not confirmed and not
//    stoppable while Claude is not connected; after reconnecting it is no
//    longer running (unknown, or ended as the resumed CLI reports it) and
//    still not stoppable.
//
// Usage: lab.mjs <yuzuno-workspace> <lab dir> <web dir> <bridge.mjs>.
// Writes report.json and screenshots there; exits 1 if a check failed.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { chromium } = await import(pathToFileURL(resolve(repo, 'web/node_modules/playwright-core/index.mjs')));
const [bin, lab, web, bridge] = process.argv.slice(2).map(p => resolve(p));
assert.ok(bin && lab && web && bridge);
const PORT = 4495, base = `http://127.0.0.1:${PORT}`;
const NODE_BIN = (process.env.HOME + '/.local/share/fnm/node-versions/v22.23.2/installation/bin');
const MARK = 't25lab'; // in every lab command, so its processes can be found
const report = { startedAt: new Date().toISOString(), lab, checks: [], pageErrors: [], requests: [], passed: false };
let core, browser, page;
const delay = ms => new Promise(r => setTimeout(r, ms));

function check(name, ok, data = {}) {
  report.checks.push({ name, ok: !!ok, at: new Date().toISOString(), ...data });
  console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(data).slice(0, 600));
  assert.ok(ok, name);
}
async function call(method, path, body) {
  const r = await fetch(base + '/api' + path, { method, headers: { 'content-type': 'application/json', 'x-yuzuno-client': 'desktop' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const get = async path => { const r = await call('GET', path); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`); return r.body; };
async function until(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await delay(500); }
  throw Error(`Timed out: ${label}`);
}
const open = port => new Promise(done => {
  const s = net.connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); done(true); });
  s.once('error', () => done(false));
});

function startCore() {
  const log = openSync(resolve(lab, 'core.log'), 'a');
  core = spawn(bin, ['--port', String(PORT), '--data-dir', resolve(lab, 'data'), '--web-dir', web, '--cwd', resolve(lab, 'project'), '--codex', '/bin/false'], {
    cwd: lab, stdio: ['ignore', log, log], detached: true,
    env: { HOME: process.env.HOME, LANG: 'C.UTF-8', PATH: `${NODE_BIN}:/usr/local/bin:/usr/bin:/bin`, YUZUNO_CLAUDE_BRIDGE: bridge, TMPDIR: resolve(lab, 'tmp') },
  });
  return until(() => get('/health'), 60000, 'Core health');
}
async function stopCore() {
  if (!core || core.exitCode !== null) return;
  core.kill('SIGINT');
  await until(async () => core.exitCode !== null, 30000, 'Core exit').catch(() => core.kill('SIGKILL'));
}
const labSleeps = () => spawnSync('pgrep', ['-af', MARK], { encoding: 'utf8' }).stdout.split('\n')
  .filter(line => line && /sleep \d+/.test(line) && !line.includes('lab.mjs'));

const detail = id => get(`/agents/${id}`);
// Found by the command its call runs: Claude may describe a shell in its
// own words, and that is the task's name (lab r3).
const tasks = d => d.turns.flatMap(turn => (turn.items || []).filter(i => i.backgroundTask)
  .map(i => ({ turn: turn.id, item: i.id, command: i.input?.command ?? '', ...i.backgroundTask })));
const byMark = (d, word) => tasks(d).find(t => t.command.includes(word));
const dockNodes = () => page.locator(".work-dock-group[aria-label='Background tasks'] .work-dock-item");
const named = t => (t.description || t.command).split('\n')[0];
let current = null; // the latest detail, for finding a task's dock node
const dockNode = word => dockNodes().filter({ hasText: named(byMark(current, word)) }).first();
const card = () => page.locator('.subagent-card');

// The prompt's own Turn, found by its text: Claude may run Turns of its own
// (after a background task ends) next to it (lab r2).
const asked = (turn, text) => (turn.items || []).some(i => i.type === 'userMessage' && JSON.stringify(i.content || '').includes(text.slice(0, 60)));
async function sendFromPage(name, text, id, approve) {
  await page.getByRole('textbox', { name: `Message ${name}`, exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  let approvals = 0;
  return until(async () => {
    const allow = page.getByRole('button', { name: 'Allow once', exact: true }).first();
    if (approve && await allow.isVisible().catch(() => false)) { await allow.click(); approvals++; await delay(800); }
    const d = await detail(id);
    const turn = d.turns.find(t => asked(t, text));
    return turn && !['inProgress', 'pending'].includes(turn.status) ? { turn, approvals, d } : null;
  }, 240000, `turn for: ${text.slice(0, 40)}`);
}
// No Turn running, and none started for a while: a Turn Claude starts on its
// own after a task ended comes a moment later.
async function idle(id) {
  let seen = -1, since = Date.now();
  return until(async () => {
    const d = await detail(id);
    if (d.turns.length !== seen || d.turns.some(t => t.status === 'inProgress')) { seen = d.turns.length; since = Date.now(); return null; }
    return Date.now() - since > 8000 && d;
  }, 180000, 'idle');
}

async function main() {
  for (const p of [PORT]) if (await open(p)) throw Error(`Port ${p} is in use; nothing was started`);
  for (const n of ['data', 'project', 'tmp']) mkdirSync(resolve(lab, n), { recursive: true });
  report.binarySha256 = spawnSync('sha256sum', [bin], { encoding: 'utf8' }).stdout.split(' ')[0];
  const health = await startCore();
  report.health = health;
  const created = await call('POST', '/agents', { name: 'T-25 lab', harness: 'claude', cwd: resolve(lab, 'project'), model: 'haiku' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id, name = 'T-25 lab';
  await until(async () => (await detail(id)).agent.connectionState === 'connected', 120000, 'Claude connected');

  browser = await chromium.launch({ executablePath: '/usr/sbin/chromium', headless: true, args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(agent => localStorage.setItem('yuzuno.selected', agent), id);
  page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', e => report.pageErrors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) report.requests.push([Date.now(), r.method(), u.pathname]); });
  await page.goto(base);
  await page.locator('.connection[data-core-status="Core connected"]').first().waitFor();

  // 1. Three background shells in one turn.
  const first = await sendFromPage(name,
    'Start these three shell commands in the background, each with its own Bash call with run_in_background set to true, then reply with the single word started without waiting for any of them: '
    + `\`sleep 30; echo alpha-done ${MARK}\`, \`sleep 120; echo beta-done ${MARK}\` and \`sleep 3; echo delta ${MARK}; exit 3\`.`, id, true);
  let d = first.d;
  current = d;
  const [alpha, beta, delta] = ['alpha', 'beta', 'delta'].map(w => byMark(d, w));
  check('one turn starts three background shells, each approved in the page, and the turn ends',
    first.turn.status === 'completed' && first.approvals >= 1 && alpha && beta && delta && [alpha, beta].every(t => t.type === 'local_bash' && t.background === true),
    { approvals: first.approvals, tasks: tasks(d).map(t => [t.taskId, t.status, t.description]) });
  await dockNode('alpha-done').waitFor();
  check('the dock lists them under Background tasks, alpha and beta running',
    await dockNode('alpha-done').evaluate(n => n.className.includes('state-running')) && await dockNode('beta-done').evaluate(n => n.className.includes('state-running')),
    { nodes: await dockNodes().allTextContents() });

  // 2. Stop beta from its card.
  const posts = () => report.requests.filter(([, m, p]) => m === 'POST' && p.includes('/tasks/'));
  await dockNode('beta-done').click();
  await card().waitFor();
  await card().getByRole('button', { name: /^Stop / }).click();
  const stopped = await until(async () => { const t = byMark(await detail(id), 'beta'); return t.status === 'stopped' && t; }, 20000, 'beta stopped');
  await card().getByText('Stopped', { exact: false }).first().waitFor();
  d = await detail(id);
  check('beta stops from its card: one request for its task id, ended by Claude\'s own report',
    posts().length === 1 && posts()[0][2] === `/api/agents/${id}/tasks/${beta.taskId}/stop` && stopped.stopRequestedAt && !stopped.stopError,
    { posts: posts().map(p => p[2]), beta: stopped });
  check('alpha keeps running after beta stopped', byMark(d, 'alpha').status === 'running', { alpha: byMark(d, 'alpha') });
  await page.screenshot({ path: resolve(lab, 'stopped.png') });
  await card().getByRole('button', { name: 'Close' }).click();

  // 3. Delta failed by itself; alpha completes after the turn ended.
  const deltaEnd = await until(async () => { const t = byMark(await detail(id), 'delta'); return ['failed', 'completed'].includes(t.status) && t; }, 30000, 'delta ended');
  check('delta, which exits 3, ends as Claude reports it', deltaEnd.status === 'failed', { delta: deltaEnd });
  const alphaEnd = await until(async () => { const t = byMark(await detail(id), 'alpha'); return t.status !== 'running' && t; }, 90000, 'alpha ended');
  d = await detail(id);
  const own = d.turns.slice(1).filter(t => t.id.startsWith('native-'));
  check('alpha completes by itself after the turn ended and lands on its own call, not in a turn of Claude\'s own',
    alphaEnd.status === 'completed' && alphaEnd.turn === first.turn.id && /exit code 0/.test(alphaEnd.result || '')
      && own.every(t => !(t.items || []).some(i => i.backgroundTask)),
    { alpha: alphaEnd, ownTurns: own.map(t => [t.id, t.status, t._yuzunoOrigin]) });
  await until(async () => await dockNode('alpha-done').evaluate(n => n.className.includes('state-succeeded')), 20000, 'dock shows alpha completed');
  check('the dock shows the late end', true, { nodes: await dockNodes().allTextContents() });

  // 4. The session goes on.
  await idle(id);
  const next = await sendFromPage(name, 'Reply with the single word ok.', id, false);
  const answer = (next.turn.items || []).filter(i => i.type === 'agentMessage').map(i => i.text).join(' ');
  check('the session goes on: a new prompt is answered', next.turn.status === 'completed' && /ok/i.test(answer), { answer: answer.slice(0, 60) });

  // 5. Refusals.
  const again = await call('POST', `/agents/${id}/tasks/${beta.taskId}/stop`);
  const unknown = await call('POST', `/agents/${id}/tasks/t25nonexistent/stop`);
  check('an ended task and an unknown id are refused, nothing sent',
    again.status === 400 && /已经结束/.test(again.body.error) && unknown.status === 400 && /没有这个后台任务/.test(unknown.body.error)
      && posts().length === 1, { again: again.body, unknown: unknown.body });

  // 6. Gamma, a Core restart and a reconnect.
  await idle(id);
  const g = await sendFromPage(name, `Start \`sleep 300; echo gamma-done ${MARK}\` in the background with the Bash tool (run_in_background true), then reply with the single word started.`, id, true);
  const gamma = byMark(g.d, 'gamma');
  current = g.d;
  check('gamma runs in the background', gamma && gamma.status === 'running', { gamma });
  await browser.close();
  browser = null;
  await stopCore();
  report.sleepsAfterCoreStopped = labSleeps();
  await startCore();
  d = await detail(id);
  browser = await chromium.launch({ executablePath: '/usr/sbin/chromium', headless: true, args: ['--disable-dev-shm-usage'] });
  const context2 = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context2.addInitScript(agent => localStorage.setItem('yuzuno.selected', agent), id);
  page = await context2.newPage();
  page.on('pageerror', e => report.pageErrors.push(e.message));
  await page.goto(base);
  await page.locator('.connection[data-core-status="Core connected"]').first().waitFor();
  await dockNode('gamma-done').click();
  await card().waitFor();
  const offline = await card().textContent();
  const refusedOffline = await call('POST', `/agents/${id}/tasks/${gamma.taskId}/stop`);
  check('after Core restarted and before Claude reconnects: not confirmed, not stoppable',
    d.agent.connectionState !== 'connected' && /Not confirmed · was running when Claude was last connected/.test(offline)
      && /Claude isn't connected/.test(offline) && refusedOffline.status === 400,
    { connection: d.agent.connectionState, refused: refusedOffline.body });
  const reconnected = await call('POST', `/agents/${id}/reconnect`);
  await until(async () => (await detail(id)).agent.connectionState === 'connected', 120000, 'reconnected');
  // Unknown from Core (its runtime ended), or ended as the resumed CLI reports
  // it (lab r4: stopped, "didn't finish before the previous session ended").
  const settled = await until(async () => { const t = byMark(await detail(id), 'gamma'); return !['running', 'pending', 'paused'].includes(t.status) && t; },
    30000, 'gamma no longer running');
  const shown = settled.status === 'unknown' ? "Status unknown · Claude's connection ended first" : { stopped: 'Stopped', failed: 'Failed', completed: 'Completed' }[settled.status];
  await card().getByText(shown, { exact: false }).first().waitFor({ timeout: 30000 });
  const cardText = await card().textContent();
  const refusedAfter = await call('POST', `/agents/${id}/tasks/${gamma.taskId}/stop`);
  check('after reconnecting it is no longer running (unknown, or ended as Claude reports it) and cannot be stopped',
    reconnected.status === 200 && (settled.status === 'unknown' ? settled.reason === 'runtime_ended' : !!settled.endedAt)
      && !/Running in the background|Not confirmed/.test(cardText) && !/Stop this task/.test(cardText) && refusedAfter.status === 400,
    { gamma: settled, refused: refusedAfter.body });
  await page.screenshot({ path: resolve(lab, 'recovered.png') });
  check('no page errors; the page asked nothing about tasks but the one stop', report.pageErrors.length === 0
    && report.requests.filter(([, , p]) => p.includes('/tasks')).length === 1, { pageErrors: report.pageErrors.slice(0, 3) });
}

try {
  await main();
  report.passed = true;
} catch (error) {
  report.error = String(error?.stack || error).slice(0, 2000);
  console.log('ERROR', report.error);
} finally {
  await browser?.close().catch(() => {});
  await stopCore();
  report.leftoverSleeps = labSleeps();
  for (const line of report.leftoverSleeps) {
    const pid = Number(line.split(' ')[0]);
    if (pid) try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  report.requestCounts = report.requests.reduce((counts, [, method, path]) => {
    const key = `${method} ${path.replace(/\/agents\/[^/]+/, '/agents/:id').replace(/\/tasks\/[^/]+/, '/tasks/:task')}`;
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  delete report.requests;
  report.finishedAt = new Date().toISOString();
  writeFileSync(resolve(lab, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
process.exit(report.passed ? 0 : 1);
