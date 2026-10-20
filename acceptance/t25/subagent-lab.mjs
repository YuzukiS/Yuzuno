// T-25 live check: a sub-agent Claude runs in the background stops from its
// own card in the dock, by its task id (R1 asked whether CLI 2.1.280's
// running-task snapshot lists sub-agents at all; Core only sends a stop for
// a task it lists). The same isolation as lab.mjs: a candidate Core from
// this worktree (port 4496, its own data), real Claude Code with Haiku,
// headless Chromium; only this lab's Core and its marked `sleep` are started
// or signalled.
//
// 1. One turn starts a background sub-agent whose task is a 90 s foreground
//    shell; its Bash call is approved in the page. The turn ends; the
//    sub-agent runs on.
// 2. Its card in the Sub-agents group stops it: one POST for its task id,
//    then `stopped` from Claude's own report.
// 3. The session goes on: a new prompt is answered.
//
// Usage: subagent-lab.mjs <yuzuno-workspace> <lab dir> <web dir> <bridge.mjs>.
// Writes report.json there; exits 1 if a check failed.
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
const PORT = 4496, base = `http://127.0.0.1:${PORT}`;
const NODE_BIN = (process.env.HOME + '/.local/share/fnm/node-versions/v22.23.2/installation/bin');
const MARK = 't25sub';
const report = { startedAt: new Date().toISOString(), lab, checks: [], pageErrors: [], stops: [], passed: false };
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
const detail = id => get(`/agents/${id}`);
const subAgents = d => d.turns.flatMap(t => (t.items || []).filter(i => i.subAgent).map(i => ({ turn: t.id, item: i.id, ...i.subAgent })));
const asked = (turn, text) => (turn.items || []).some(i => i.type === 'userMessage' && JSON.stringify(i.content || '').includes(text.slice(0, 60)));
const labSleeps = () => spawnSync('pgrep', ['-af', MARK], { encoding: 'utf8' }).stdout.split('\n')
  .filter(line => line && /sleep \d+/.test(line) && !line.includes('subagent-lab.mjs'));

async function allowWhileWaiting(fn, ms, label) {
  let approvals = 0;
  const value = await until(async () => {
    const allow = page.getByRole('button', { name: 'Allow once', exact: true }).first();
    if (await allow.isVisible().catch(() => false)) { await allow.click(); approvals++; await delay(800); }
    return fn();
  }, ms, label);
  return { value, approvals };
}
async function send(name, text) {
  await page.getByRole('textbox', { name: `Message ${name}`, exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}

async function main() {
  if (await open(PORT)) throw Error(`Port ${PORT} is in use; nothing was started`);
  for (const n of ['data', 'project', 'tmp']) mkdirSync(resolve(lab, n), { recursive: true });
  const log = openSync(resolve(lab, 'core.log'), 'a');
  core = spawn(bin, ['--port', String(PORT), '--data-dir', resolve(lab, 'data'), '--web-dir', web, '--cwd', resolve(lab, 'project'), '--codex', '/bin/false'], {
    cwd: lab, stdio: ['ignore', log, log], detached: true,
    env: { HOME: process.env.HOME, LANG: 'C.UTF-8', PATH: `${NODE_BIN}:/usr/local/bin:/usr/bin:/bin`, YUZUNO_CLAUDE_BRIDGE: bridge, TMPDIR: resolve(lab, 'tmp') },
  });
  await until(() => get('/health'), 60000, 'Core health');
  const created = await call('POST', '/agents', { name: 'T-25 sub-agent lab', harness: 'claude', cwd: resolve(lab, 'project'), model: 'haiku' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.id, name = 'T-25 sub-agent lab';
  await until(async () => (await detail(id)).agent.connectionState === 'connected', 120000, 'Claude connected');
  browser = await chromium.launch({ executablePath: '/usr/sbin/chromium', headless: true, args: ['--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  await context.addInitScript(agent => localStorage.setItem('yuzuno.selected', agent), id);
  page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', e => report.pageErrors.push(e.message));
  page.on('response', async r => {
    if (r.request().method() === 'POST' && new URL(r.url()).pathname.includes('/tasks/'))
      report.stops.push({ path: new URL(r.url()).pathname, status: r.status(), body: await r.text().catch(() => '') });
  });
  await page.goto(base);
  await page.locator('.connection[data-core-status="Core connected"]').first().waitFor();

  // 1. A background sub-agent that stays busy.
  const prompt = 'Use the Agent tool with run_in_background set to true to start one general-purpose sub-agent, and do not wait for it. '
    + `Its task, word for word: "Run the shell command \`sleep 90; echo sub-done ${MARK}\` with the Bash tool in the foreground, then report its output." `
    + 'After starting it, reply with the single word started.';
  await send(name, prompt);
  const { value: started, approvals } = await allowWhileWaiting(async () => {
    const d = await detail(id);
    const turn = d.turns.find(t => asked(t, prompt));
    const sub = subAgents(d).find(s => s.background === true && s.status === 'running' && s.taskId);
    // Its shell runs: the sub-agent is busy, not just launched.
    return turn && turn.status === 'completed' && sub && labSleeps().length && { d, sub };
  }, 180000, 'the background sub-agent running its shell after the turn ended');
  check('a background sub-agent runs its shell (approved in the page) after its turn ended', true,
    { approvals, sub: started.sub, sleeps: labSleeps().length });

  // 2. Stop it from its card.
  const node = page.locator(".work-dock-group[aria-label='Sub-agents'] .work-dock-item").first();
  await node.click();
  const card = page.locator('.subagent-card');
  await card.waitFor();
  await card.getByRole('button', { name: /^Stop / }).click();
  const stopped = await until(async () => {
    const s = subAgents(await detail(id)).find(x => x.taskId === started.sub.taskId);
    return s && ['stopped', 'completed', 'failed'].includes(s.status) && s;
  }, 30000, 'the sub-agent ends');
  check('its card stops it: one request for its task id, accepted, and stopped by Claude\'s own report',
    report.stops.length === 1 && report.stops[0].path === `/api/agents/${id}/tasks/${started.sub.taskId}/stop` && report.stops[0].status === 200
      && stopped.status === 'stopped' && !!stopped.stopRequestedAt, { stops: report.stops, sub: stopped });

  // 3. The session goes on.
  await until(async () => !(await detail(id)).turns.some(t => t.status === 'inProgress'), 120000, 'idle');
  await delay(8000);
  await until(async () => !(await detail(id)).turns.some(t => t.status === 'inProgress'), 120000, 'idle again');
  const next = 'Reply with the single word ok.';
  await send(name, next);
  const answered = await until(async () => {
    const t = (await detail(id)).turns.find(x => asked(x, next));
    return t && t.status !== 'inProgress' && t;
  }, 180000, 'the next prompt');
  const answer = (answered.items || []).filter(i => i.type === 'agentMessage').map(i => i.text).join(' ');
  check('the session goes on: a new prompt is answered', answered.status === 'completed' && /ok/i.test(answer), { answer: answer.slice(0, 60) });
  check('no page errors', report.pageErrors.length === 0, { pageErrors: report.pageErrors.slice(0, 3) });
}

try {
  await main();
  report.passed = true;
} catch (error) {
  report.error = String(error?.stack || error).slice(0, 2000);
  console.log('ERROR', report.error);
} finally {
  await browser?.close().catch(() => {});
  if (core && core.exitCode === null) {
    core.kill('SIGINT');
    await until(async () => core.exitCode !== null, 30000, 'Core exit').catch(() => core.kill('SIGKILL'));
  }
  report.leftoverSleeps = labSleeps();
  for (const line of report.leftoverSleeps) {
    const pid = Number(line.split(' ')[0]);
    if (pid) try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(resolve(lab, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
process.exit(report.passed ? 0 : 1);
