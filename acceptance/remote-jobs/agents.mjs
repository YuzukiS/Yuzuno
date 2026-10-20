// T-108 acceptance: real Claude Agents and Jobs on different machines, through
// one isolated Core (its own port and data folder, never the daily Core).
//
//   A. A Claude Agent running on the remote machine submits a Job without a
//      machineId: it runs on the Core host, in a folder of this lab.
//   B. A Claude Agent running on the Core host submits a Job with the remote
//      machine's machineId: it runs there, under the machine's data root.
//      First in the machine's default strict mode (where the machine cannot
//      hold the limits, it is refused and nothing starts), then with the
//      limited mode chosen for the machine.
//
// Each Job is checked by its record (Agent, task, executor, machine, limits),
// its log (the executing host's name and machine-id digest), the file it wrote
// on the machine that ran it, and the submitting Agent's mailbox. Identities
// are compared only as digests; no account detail or credential is read.
// Afterwards the remote account is checked for files written outside its data
// root's parent (the user allows new files only there).
//
// Usage: agents.mjs <yuzuno-workspace> <lab dir> <web dir> <bridge.mjs>
// Required env: LAB_TARGET (the authorized SSH alias), LAB_ROOT (the machine's
// data root) and LAB_ALLOWED (the only remote folder new files may appear in).
// No machine or destination is selected by default. LAB_MACHINE is extra JSON
// for the machine, e.g.
// the option that keeps the Claude host's files under the root), LAB_MODEL
// (default haiku), LAB_PORT (default 4612).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';

const [bin, lab, web, bridge] = process.argv.slice(2).map(p => resolve(p));
assert.ok(bin && lab && web && bridge, 'usage: agents.mjs <yuzuno-workspace> <lab dir> <web dir> <bridge.mjs>');
const TARGET = process.env.LAB_TARGET;
const ROOT = process.env.LAB_ROOT;
const ALLOWED = process.env.LAB_ALLOWED;
assert.ok(TARGET?.trim() && ROOT?.trim() && ALLOWED?.trim(),
  'Set LAB_TARGET, LAB_ROOT and LAB_ALLOWED to the authorized machine and lab folders');
const MACHINE_EXTRA = JSON.parse(process.env.LAB_MACHINE || '{}');
const MODEL = process.env.LAB_MODEL || 'haiku';
const PORT = Number(process.env.LAB_PORT || 4612), base = `http://127.0.0.1:${PORT}`;
const NODE_BIN = dirname(process.execPath);
const MARK = `t108-${Date.now().toString(36)}`;
const report = { startedAt: new Date().toISOString(), target: TARGET, root: ROOT, model: MODEL, mark: MARK, checks: [], turns: [], approvals: [], jobs: {}, remote: {}, passed: false };
let core;
const delay = ms => new Promise(r => setTimeout(r, ms));

function check(name, ok, data = {}) {
  report.checks.push({ name, ok: !!ok, at: new Date().toISOString(), ...data });
  console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(data).slice(0, 700));
  assert.ok(ok, name);
}
async function call(method, path, body) {
  const r = await fetch(base + '/api' + path, { method, headers: { 'content-type': 'application/json', 'x-yuzuno-client': 'desktop' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: r.status, body: parsed };
}
const get = async path => { const r = await call('GET', path); assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body).slice(0, 300)}`); return r.body; };
async function until(fn, ms, label, every = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await delay(every); }
  throw Error(`Timed out: ${label}`);
}
const portOpen = port => new Promise(done => {
  const s = net.connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); done(true); });
  s.once('error', () => done(false));
});
/** A short script on the remote machine (batch mode, strict host keys). */
function remote(script) {
  const r = spawnSync('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', TARGET, 'bash -s'],
    { input: script, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim().slice(0, 300) };
}
const sha16 = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const localMachine = sha16(readFileSync('/etc/machine-id'));
// What each Job prints: where it ran, as the host's name and the first 16 hex
// of SHA-256 over its /etc/machine-id file (what `sha256sum </etc/machine-id` gives).
const evidenceCommand = mark => `printf 'host=%s\\n' "$(hostname)"; printf 'machine=%s\\n' "$(sha256sum </etc/machine-id | cut -c1-16)"; printf 'cwd=%s\\n' "$(pwd)"; printf '%s\\n' ${mark} > produced.txt`;

const detail = id => get(`/agents/${id}`);
function itemText(i) {
  const c = i.content ?? i.text;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(b => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
  return '';
}
const turnWith = (d, tag) => d.turns.find(t => (t.items || []).some(i => i.type === 'userMessage' && itemText(i).includes(tag)));

/** Allow each pending tool request of this Agent once (as "Allow once"). */
async function allowPending(id, label) {
  const d = await detail(id);
  for (const request of d.pending || []) {
    const decisions = request.params?.availableDecisions || [];
    const decision = decisions.includes('accept') ? 'accept' : 'allow';
    const r = await call('POST', `/requests/${encodeURIComponent(request.id)}/respond`, { response: { decision } });
    report.approvals.push({ label, requestId: request.id, tool: request.params?.toolName ?? request.method, decision, http: r.status });
  }
}
async function send(id, tag, text) {
  const r = await call('POST', `/agents/${id}/messages`, { clientMessageId: randomUUID(), text: `${tag}: ${text}` });
  check(`${tag}: prompt accepted`, r.status === 200 && ['accepted', 'queued'].includes(r.body?.status), { http: r.status, status: r.body?.status, error: r.body?.error });
}
async function finished(id, tag, ms = 300000) {
  return until(async () => {
    const d = await detail(id);
    if (d.pending?.length) await allowPending(id, tag);
    const turn = turnWith(d, tag);
    if (turn && turn.status !== 'inProgress' && d.agent.status !== 'working') {
      const items = turn.items || [];
      const record = { tag, agent: id, turn: turn.id, status: turn.status,
        tools: items.filter(i => !['userMessage', 'agentMessage', 'reasoning'].includes(i.type)).map(i => `${i.type}:${i.name || i.toolName || i.tool || ''}:${i.status || ''}`),
        answer: items.filter(i => i.type === 'agentMessage').map(i => i.text).join(' ').slice(0, 400) };
      report.turns.push(record);
      console.log('TURN', JSON.stringify(record).slice(0, 600));
      return { turn, d };
    }
    return null;
  }, ms, `${tag} ends`, 1500);
}
/** The one Job this Agent submitted under this requestId (whose name carries it too). */
async function jobOf(agentId, requestId) {
  return until(async () => {
    const listed = await get(`/jobs?agentId=${encodeURIComponent(agentId)}`);
    const jobs = (listed.jobs || listed).filter(j => j.agentId === agentId && (j.requestId === requestId || (j.name || '').includes(requestId)));
    return jobs.length === 1 ? jobs[0] : null;
  }, 120000, `job ${requestId} of ${agentId}`);
}
const terminal = id => until(async () => { const job = await get(`/jobs/${id}`); return ['succeeded', 'failed', 'cancelled', 'rejected', 'interrupted'].includes(job.status) && job; }, 300000, `job ${id} ends`, 2000);
const logOf = async id => (await get(`/jobs/${id}/logs`)).text || '';
// LAB_DRY=1: the same Jobs submitted through the HTTP API in each Agent's name,
// without model turns, to prove this script's API paths. Never the acceptance
// of real Agents, and reported as such.
const DRY = process.env.LAB_DRY === '1';
report.dry = DRY;
/** Have the Agent submit this Job (a real model turn), or in a dry run submit it in its name. */
async function agentSubmits(agentId, tag, args) {
  if (DRY) {
    const r = await call('POST', '/jobs', { ...args, agentId });
    report.turns.push({ tag, agent: agentId, dry: true, http: r.status, error: r.body?.error });
    return r;
  }
  await send(agentId, tag, `Use the yuzuno tool job_submit (load it with tool search if needed) exactly once with exactly these arguments: ${JSON.stringify(args)}. Then reply with the jobId it returned, or the error.`);
  return finished(agentId, tag);
}
async function mailFor(agentId, jobId) {
  const r = await call('POST', '/collaboration/peer_read', { agentId, priority: 'normal', limit: 200 });
  return (r.body?.messages || []).filter(m => (m.metadata || {}).jobId === jobId);
}

async function main() {
  if (await portOpen(PORT)) throw Error(`Port ${PORT} is in use; nothing was started`);
  for (const n of ['data', 'tmp', 'code', 'code/local-agent', 'a-work']) mkdirSync(resolve(lab, n), { recursive: true });

  // The remote account, before anything runs: its identity, its own Claude
  // login in the data root (status only), and the moment to compare against.
  const pre = remote(`set -u
R=${ROOT.replace(/^~/, '$HOME')}
printf 'host=%s\\n' "$(hostname)"
printf 'machine=%s\\n' "$(sha256sum </etc/machine-id | cut -c1-16)"
printf 'home=%s\\n' "$HOME"
printf 'since=%s\\n' "$(date '+%Y-%m-%d %H:%M:%S')"
for d in .yuzuno .yuzuno-next; do [ -e "$HOME/$d" ] && echo "outside=$d" ; done
env -i HOME="$HOME" PATH=/usr/bin:/bin LANG=C.UTF-8 CLAUDE_CONFIG_DIR="$R/claude-config" TMPDIR="$R/tmp" XDG_CACHE_HOME="$R/xdg/cache" XDG_CONFIG_HOME="$R/xdg/config" XDG_DATA_HOME="$R/xdg/data" XDG_STATE_HOME="$R/xdg/state" DISABLE_AUTOUPDATER=1 "$HOME/.local/bin/claude" auth status --json 2>/dev/null | python3 -c 'import json,sys; s=json.load(sys.stdin); print("auth=%s %s" % (s.get("loggedIn"), s.get("authMethod")))'
mkdir -p -m 700 "$R/work" "$R/work/${MARK}" "$R/work/${MARK}/agent" "$R/work/${MARK}/b"
cd "$R/work/${MARK}" && printf 'work=%s\\n' "$(pwd)"`);
  const facts = Object.fromEntries(pre.out.split('\n').map(l => l.split('=')).filter(p => p.length >= 2).map(([k, ...v]) => [k, v.join('=')]));
  report.remote.before = { host: facts.host, machine: facts.machine, since: facts.since, auth: facts.auth, work: facts.work, outside: facts.outside ?? null };
  check('the remote machine answers, is not this host, and its Claude login in the data root is signed in (status only)',
    pre.status === 0 && facts.machine && facts.machine !== localMachine && /^True /.test(facts.auth || '') && !facts.outside,
    { remote: report.remote.before, localMachine });
  const remoteWork = facts.work;
  // The account's entries in the shared temporary folders now: other work of
  // that account changes its own (an existing Ray session, say); only entries
  // that are new afterwards count.
  const tmpEntries = () => remote(`find /tmp /var/tmp -mindepth 1 -maxdepth 1 -user "$(id -un)" -print 2>/dev/null | sort`).out.split('\n').filter(Boolean);
  const tmpBefore = new Set(tmpEntries());

  const log = openSync(resolve(lab, 'core.log'), 'a');
  core = spawn(bin, ['--port', String(PORT), '--data-dir', resolve(lab, 'data'), '--web-dir', web, '--cwd', resolve(lab, 'code'), '--codex', '/bin/false'], {
    cwd: lab, stdio: ['ignore', log, log], detached: true,
    env: { HOME: process.env.HOME, LANG: 'C.UTF-8', PATH: `${NODE_BIN}:/usr/local/bin:/usr/bin:/bin`, YUZUNO_CLAUDE_BRIDGE: bridge, TMPDIR: resolve(lab, 'tmp'),
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '', DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || '' },
  });
  await until(() => get('/health'), 90000, 'Core health');

  // The machine, with its data root under the allowed folder.
  const added = await call('POST', '/machines', { name: `${TARGET} (T-108 lab)`, target: TARGET, codex: 'codex', defaultCwd: `${remoteWork}/agent`, dataRoot: ROOT, ...MACHINE_EXTRA });
  check('the remote machine is registered with its data root', added.status === 200 && added.body?.id, { http: added.status, error: added.body?.error, dataRoot: added.body?.dataRoot });
  const machineId = added.body.id;
  const checked = await call('POST', `/machines/${machineId}/check`);
  const claude = checked.body?.harnesses?.find(h => h.harness === 'claude');
  check('machine check: reachable, with Claude Code found there', checked.status === 200 && checked.body.reachable && claude?.found,
    { platform: checked.body?.host?.platform, claude: claude?.version, error: claude?.error });

  const task = await call('POST', '/collaboration/task_create', { requestId: `task-${MARK}`, title: 'T-108 Agents and Jobs on different machines', status: 'doing' });
  const taskId = task.body?.task?.id ?? task.body?.id;
  check('a task to attribute the Jobs to', task.status === 200 && taskId, { http: task.status, taskId });

  // The two real Claude Agents.
  const created = { remote: await call('POST', '/agents', { name: 'Claude on the remote machine', harness: 'claude', cwd: `${remoteWork}/agent`, model: MODEL, machineId }),
    local: await call('POST', '/agents', { name: 'Claude on the Core host', harness: 'claude', cwd: resolve(lab, 'code/local-agent'), model: MODEL }) };
  check('a Claude Agent on each machine', created.remote.status === 200 && created.remote.body?.remote?.machine?.id === machineId && created.local.status === 200 && !created.local.body?.remote,
    { remote: created.remote.status, local: created.local.status, error: created.remote.body?.error ?? created.local.body?.error });
  const agents = { remote: created.remote.body.id, local: created.local.body.id };
  for (const [which, id] of Object.entries(agents)) {
    await until(async () => { const d = await detail(id); if (d.agent.error && d.agent.connectionState === 'disconnected') throw Error(d.agent.error); return d.agent.connectionState === 'connected' && d; }, 240000, `${which} Agent connected`);
  }
  report.agents = agents;

  // A. The remote Agent submits a Job without machineId: it runs on the Core host.
  const aRequest = `t108a-${MARK}`, aWork = resolve(lab, 'a-work');
  const resources = { cpuMillis: 200, memoryMiB: 64, swapMiB: 0 };
  await agentSubmits(agents.remote, 'T108-A', { requestId: aRequest, taskId, name: `submitted from the remote machine ${aRequest}`,
    cwd: aWork, argv: ['/bin/sh', '-c', evidenceCommand(`a-${MARK}`)], resources, guardGit: false });
  const aJob = await jobOf(agents.remote, aRequest);
  const aJobRecord = await terminal(aJob.id), aLog = await logOf(aJob.id);
  const aFile = existsSync(resolve(aWork, 'produced.txt')) ? readFileSync(resolve(aWork, 'produced.txt'), 'utf8').trim() : null;
  report.jobs.A = { id: aJob.id, status: aJobRecord.status, agentId: aJobRecord.agentId, agentMachine: aJobRecord.agentMachine ?? null,
    task: aJobRecord.taskRef, executor: aJobRecord.executor ?? null, machine: aJobRecord.machine?.id ?? null, file: aFile };
  const ofTask = job => job.taskRef === taskId || job.taskId === taskId;
  check('A: the remote Agent\'s Job ran on the Core host (its log names this host\'s machine digest, not the remote one), in this lab\'s folder, and wrote its file here',
    aJobRecord.status === 'succeeded' && aJobRecord.agentId === agents.remote && aJobRecord.agentMachine?.id === machineId && ofTask(aJobRecord) && !aJobRecord.executor
      && aLog.includes(`machine=${localMachine}`) && !aLog.includes(`machine=${facts.machine}`) && aLog.includes(`cwd=${aWork}`) && aFile === `a-${MARK}`,
    { ...report.jobs.A, localHost: hostname() });
  const aMail = await until(async () => (await mailFor(agents.remote, aJob.id)).length > 0 && await mailFor(agents.remote, aJob.id), 120000, 'A mail');
  check('A: the remote Agent got the Job\'s notification', aMail.length >= 1, { mails: aMail.map(m => m.metadata?.status) });

  // B. The Core host's Agent submits a Job to the remote machine, first in
  // its default strict mode, then with the limited mode chosen for it.
  const bWork = `${remoteWork}/b`;
  const bArgs = (requestId, mark) => ({ requestId, taskId, machineId, name: `submitted from the Core host ${requestId}`, cwd: bWork,
    argv: ['/bin/sh', '-c', evidenceCommand(mark)], resources, guardGit: false });
  const strictRequest = `t108b-strict-${MARK}`;
  await agentSubmits(agents.local, 'T108-B1', bArgs(strictRequest, `strict-${MARK}`));
  const strictJob = await jobOf(agents.local, strictRequest);
  const strictRecord = await terminal(strictJob.id);
  const strictFile = remote(`cat ${bWork}/produced.txt 2>/dev/null || true`).out;
  report.jobs.Bstrict = { id: strictJob.id, status: strictRecord.status, reason: strictRecord.reason, file: strictFile || null };
  check('B (strict): the machine cannot hold strict limits, so the Job is refused there and nothing ran',
    strictRecord.status === 'rejected' && /nothing was started/.test(strictRecord.reason || '') && /CPU cannot be limited/.test(strictRecord.reason || '') && !strictFile,
    report.jobs.Bstrict);

  const machines = await get('/machines');
  const machine = (machines.machines || machines).find(m => m.id === machineId);
  const put = await call('PUT', `/machines/${machineId}`, { ...machine, limitMode: 'limited' });
  check('the limited mode is chosen for the machine and kept', put.status === 200 && (put.body?.limitMode ?? put.body?.machine?.limitMode) === 'limited', { http: put.status, error: put.body?.error });
  const bRequest = `t108b-${MARK}`;
  await agentSubmits(agents.local, 'T108-B2', bArgs(bRequest, `b-${MARK}`));
  const bJob = await jobOf(agents.local, bRequest);
  const bRecord = await terminal(bJob.id), bLog = await logOf(bJob.id);
  const bFile = remote(`cat ${bWork}/produced.txt 2>/dev/null || true`).out;
  const attemptDir = remote(`d=${ROOT.replace(/^~/, '$HOME')}/jobs/${bJob.id}; [ -d "$d" ] && ls "$d" | head -3 && stat -c '%a %U' "$d"`).out;
  const limits = bRecord.result?.evidence?.result?.limits ?? null;
  report.jobs.B = { id: bJob.id, status: bRecord.status, agentId: bRecord.agentId, agentMachine: bRecord.agentMachine ?? null, task: bRecord.taskRef,
    executor: bRecord.executor, root: bRecord.remote?.root ?? null, file: bFile || null, attemptDir, limits };
  check('B (limited): the Core host Agent\'s Job ran on the remote machine (its log names that machine\'s digest), in its folder, under the machine\'s data root',
    bRecord.status === 'succeeded' && bRecord.agentId === agents.local && !bRecord.agentMachine && ofTask(bRecord) && bRecord.executor?.machineId === machineId
      && bLog.includes(`machine=${facts.machine}`) && !bLog.includes(`machine=${localMachine}`) && bLog.includes(`cwd=${bWork}`) && bFile === `b-${MARK}` && attemptDir.length > 0,
    report.jobs.B);
  // Held only where the account lingers (T-108 R1, Lead seq 4179): there,
  // memory in its own scope and CPU declared; otherwise nothing is held.
  const lingers = limits?.facts?.linger === true;
  check(lingers
    ? 'B (limited): memory is held in its own scope there, CPU is only declared, and the record says so'
    : 'B (limited): the account does not linger, so nothing is held in a scope and the record says so',
    lingers
      ? limits?.memory === 'limited' && limits?.cpu === 'declared' && /^\d+$/.test(limits?.held?.['memory.max'] || '') && (limits?.caveats || []).some(c => /CPU is declared only/.test(c))
      : limits?.memory === 'declared' && limits?.cpu === 'declared' && !limits?.held && (limits?.caveats || []).some(c => /this account does not linger/.test(c)),
    { limits });
  const bMail = await until(async () => (await mailFor(agents.local, bJob.id)).length > 0 && await mailFor(agents.local, bJob.id), 120000, 'B mail');
  check('B: the Core host Agent got the Job\'s notification', bMail.length >= 1, { mails: bMail.map(m => m.metadata?.status) });

  // After full model turns on the remote machine: nothing new outside the
  // allowed folder in the places Claude and Yuzuno could write.
  const after = remote(`set -u
for p in "$HOME/.claude" "$HOME/.claude.json" "$HOME/.cache" "$HOME/.config" "$HOME/.local" "$HOME/.yuzuno" "$HOME/.yuzuno-next" "$HOME/yuzuno-jobs-acceptance"; do
  [ -e "$p" ] && find "$p" -maxdepth 4 -newermt '${facts.since}' -print 2>/dev/null | head -20
done
echo "--- inside the data root"
find ${ROOT.replace(/^~/, '$HOME')} -maxdepth 2 -newermt '${facts.since}' -printf '%P\\n' 2>/dev/null | sort | head -40`);
  const [outside, inside] = after.out.split('--- inside the data root');
  const newTmp = tmpEntries().filter(entry => !tmpBefore.has(entry));
  report.remote.writtenOutside = [...outside.trim().split('\n').filter(Boolean), ...newTmp];
  report.remote.writtenInsideRoot = (inside || '').trim().split('\n').filter(Boolean);
  check(`after the model turns and Jobs: nothing new outside ${ALLOWED} in the places checked on the remote account`,
    after.status === 0 && report.remote.writtenOutside.length === 0, { outside: report.remote.writtenOutside, insideRoot: report.remote.writtenInsideRoot.slice(0, 20) });
}

try {
  await main();
  report.passed = true;
} catch (error) {
  report.error = String(error?.stack || error).slice(0, 2000);
  console.log('ERROR', report.error);
} finally {
  if (core && core.exitCode === null) {
    core.kill('SIGINT');
    await until(async () => core.exitCode !== null, 30000, 'Core exit').catch(() => core.kill('SIGKILL'));
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(resolve(lab, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
process.exit(report.passed ? 0 : 1);
